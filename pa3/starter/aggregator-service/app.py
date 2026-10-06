"""Aggregate distinct item results with an idle timeout and terminal-order memory."""
import json
import os
import threading
import time

import pika

in_flight = {}
finalized = set()
lock = threading.Lock()
IDLE_TIMEOUT_SECONDS = float(os.environ.get('AGGREGATOR_IDLE_TIMEOUT_SECONDS', '5'))
SWEEP_INTERVAL_SECONDS = 1.0


def get_rabbitmq_connection():
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


def publish_completion(message):
    """Own connection per thread; confirm publication before finalizing state."""
    connection = get_rabbitmq_connection()
    try:
        channel = connection.channel()
        channel.queue_declare(queue='orders.complete', durable=True)
        channel.confirm_delivery()
        channel.basic_publish(
            exchange='', routing_key='orders.complete', body=json.dumps(message),
            properties=pika.BasicProperties(delivery_mode=2), mandatory=True,
        )
    finally:
        connection.close()


def completion_message(order_id, state):
    missing = sorted(set(range(state['total'])) - state['results'].keys())
    return {
        'orderId': order_id, 'correlationId': order_id,
        'status': 'partial' if missing else 'complete',
        'totalItems': state['total'], 'receivedItems': len(state['results']),
        'itemResults': [state['results'][i] for i in sorted(state['results'])],
        'missingItemIndexes': missing,
    }


def try_publish(order_id):
    """Claim a pending snapshot under the lock; perform network I/O outside it."""
    with lock:
        state = in_flight.get(order_id)
        if state is None or state['pending'] is None or state['publishing']:
            return
        state['publishing'] = True
        message = state['pending']
    try:
        publish_completion(message)
    except Exception as error:
        print(f'[Aggregator] Publication failed for {order_id}; retrying: {error}', flush=True)
        with lock:
            state['publishing'] = False
        return
    with lock:
        finalized.add(order_id)
        del in_flight[order_id]


def aggregate_result(ch, method, properties, body):
    try:
        result = json.loads(body)
        order_id = result['orderId']
        index, total = result['itemIndex'], result['totalItems']
        if not isinstance(order_id, str) or not order_id:
            raise ValueError('invalid orderId')
        if result['correlationId'] != order_id:
            raise ValueError('correlationId must equal orderId')
        if type(total) is not int or total <= 0:
            raise ValueError('totalItems must be a positive integer')
        if type(index) is not int or not 0 <= index < total:
            raise ValueError('itemIndex outside expected range')
        with lock:
            if order_id not in finalized:
                state = in_flight.setdefault(order_id, {
                    'total': total, 'results': {}, 'last_activity': time.monotonic(),
                    'pending': None, 'publishing': False,
                })
                if total != state['total']:
                    raise ValueError('inconsistent totalItems for order')
                if state['pending'] is None:
                    # A valid duplicate refreshes activity but never replaces the first result.
                    state['last_activity'] = time.monotonic()
                    state['results'].setdefault(index, result)
                    if len(state['results']) == total:
                        state['pending'] = completion_message(order_id, state)
        try_publish(order_id)
    except (ValueError, KeyError, TypeError) as error:
        print(f'[Aggregator] Discarding malformed result: {error}', flush=True)
    ch.basic_ack(delivery_tag=method.delivery_tag)


def sweep_once():
    now = time.monotonic()
    with lock:
        for order_id, state in in_flight.items():
            if state['pending'] is None and now - state['last_activity'] >= IDLE_TIMEOUT_SECONDS:
                state['pending'] = completion_message(order_id, state)
        pending = [order_id for order_id, state in in_flight.items() if state['pending'] is not None]
    for order_id in pending:
        try_publish(order_id)


def sweep_timeouts():
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        sweep_once()


def main():
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    channel.queue_declare(queue='orders.results', durable=True)
    channel.queue_declare(queue='orders.complete', durable=True)
    channel.basic_qos(prefetch_count=1)
    threading.Thread(target=sweep_timeouts, daemon=True).start()
    channel.basic_consume(queue='orders.results', on_message_callback=aggregate_result)
    print('[Aggregator] Waiting for results...', flush=True)
    channel.start_consuming()


if __name__ == '__main__':
    main()
