"""
Router Service
==============
Your job: implement two EIP patterns on top of the connection handling and
consume loop already wired up below.

1. SPLITTER: Break a multi-item order into one message per line item.
2. CONTENT-BASED ROUTER: Route each item message to a queue chosen by
   item['type'] -- physical / digital / subscription.

Consumes from: orders.incoming
Publishes to:  orders.physical, orders.digital, orders.subscription

Required shape of each item message you publish (the aggregator and the
tests depend on every one of these fields being present):

    {
        "orderId": "<same orderId as the incoming order>",
        "correlationId": "<same value as orderId -- this is what lets the
                            aggregator group results from the same order>",
        "itemIndex": <0-based position of this item within order['items']>,
        "totalItems": <len(order['items'])>,
        "item": <the original item object, unchanged>
    }

Every item message for a given order MUST carry the same correlationId and
the same totalItems -- that is how correlation is preserved once the order
has been split into independent messages travelling independent paths.
"""

import json
import pika
import os


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


# Map an item's `type` field to the routing key (== queue name, since we
# publish to the default exchange) it should be sent to.
ROUTES = {
    'physical': 'orders.physical',
    'digital': 'orders.digital',
    'subscription': 'orders.subscription',
}


def route_order(ch, method, properties, body):
    """Split, route persistently, then acknowledge the original order."""
    try:
        order = json.loads(body)
        order_id = order['orderId']
        items = order['items']
        if not isinstance(order_id, str) or not order_id or not isinstance(items, list):
            raise ValueError('invalid orderId or items')
        if any(not isinstance(item, dict) for item in items):
            raise ValueError('items must be objects')
    except (ValueError, KeyError, TypeError) as error:
        print(f'[Router] Discarding malformed order: {error}', flush=True)
        ch.basic_ack(delivery_tag=method.delivery_tag)
        return

    connection = get_rabbitmq_connection()
    try:
        channel = connection.channel()
        for queue in (*ROUTES.values(), 'orders.unroutable', 'orders.complete'):
            channel.queue_declare(queue=queue, durable=True)
        channel.confirm_delivery()
        for index, item in enumerate(items):
            message = {
                'orderId': order_id,
                'correlationId': order_id,
                'itemIndex': index,
                'totalItems': len(items),
                'item': item,
            }
            route = ROUTES.get(item.get('type'), 'orders.unroutable')
            if route == 'orders.unroutable':
                print(f'[Router] Unsupported type at {order_id}/{index}; quarantined', flush=True)
            channel.basic_publish(
                exchange='', routing_key=route, body=json.dumps(message),
                properties=pika.BasicProperties(delivery_mode=2), mandatory=True,
            )
        if not items:
            channel.basic_publish(
                exchange='', routing_key='orders.complete',
                body=json.dumps({
                    'orderId': order_id, 'correlationId': order_id,
                    'status': 'complete', 'totalItems': 0, 'receivedItems': 0,
                    'itemResults': [], 'missingItemIndexes': [],
                }), properties=pika.BasicProperties(delivery_mode=2), mandatory=True,
            )
    finally:
        connection.close()
    ch.basic_ack(delivery_tag=method.delivery_tag)
    print(f'[Router] Routed {len(items)} items for {order_id}', flush=True)


def main():
    """Main entry point: connect to RabbitMQ and start consuming orders."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.incoming', durable=True)

    # Fair dispatch: don't give more than one message to a worker at a time
    channel.basic_qos(prefetch_count=1)

    # Start consuming
    channel.basic_consume(queue='orders.incoming', on_message_callback=route_order)

    print('[Router] Waiting for orders...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
