# Failure analysis

Observed on 4 November 2026 against the supplied mocks in hand-rolled mode. Linked JSON records contain the full real traces, provider logs/effects and metrics. Excerpts below select hops without changing their values. Temporary queue metrics are snapshots, not a continuous alert history.

## Payment declined
Trigger: Configure payment authorize failMode=always, failStatus=402. Submit a fresh web order.

What the system does: Permanent first-step failure stops checkout immediately; inventory and shipping do not run.

[Full observed record](../verification/01-payment-declined.json); correlationId `2a4e8cdf-0f5e-4358-8cbc-f9b1e5f09914`.

```json
[
  {
    "hopId": "8abd6e5c-f6a2-4596-983e-5e56c9a20f82",
    "causationId": "00ad5018-3336-4a90-9476-24fda3ffc508",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:40.826Z"
  },
  {
    "hopId": "6e094246-c5db-443d-96a9-3c40c8cddc3f",
    "causationId": "757ad00f-a74d-407a-b9a8-6e706aa1a567",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:40.831Z"
  },
  {
    "hopId": "dab9dac1-52fa-48af-8f7c-905e11bf75c1",
    "causationId": "6e094246-c5db-443d-96a9-3c40c8cddc3f",
    "operation": "payment",
    "status": "failed",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:40.837Z"
  },
  {
    "hopId": "21a51e9f-6b76-415d-8c61-5121ff36e049",
    "causationId": "dab9dac1-52fa-48af-8f7c-905e11bf75c1",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:40.845Z"
  },
  {
    "hopId": "57fede42-038b-4637-80f2-d5939ece98f5",
    "causationId": "9810e7d0-d3fd-4eb1-b979-c4501f9c4bca",
    "operation": "notify.send",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:40.849Z"
  }
]
```

Final state: `failed`; code `payment_declined`. Observed provider effects: `{"payment": [], "inventory": [], "shipping": [], "notification": ["notice"]}`.

Alert: none, by design: a permanent business rejection is an outcome, not an infrastructure alarm.

Operator action: Read the rejection; a corrected purchase needs a fresh orderId, not a replay of this terminal order.

## Inventory unavailable
Trigger: Configure inventory reserve failMode=always and submit a fresh web order.

What the system does: Payment succeeds, reservation fails, then payment_refund runs once.

[Full observed record](../verification/02-inventory-unavailable.json); correlationId `29af33d9-2d5c-49fe-892e-cc59dc599a08`.

```json
[
  {
    "hopId": "21419213-e157-4b78-8d4a-1be01f682545",
    "causationId": "4a703e6a-fe58-4402-ab7d-853977211716",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.245Z"
  },
  {
    "hopId": "09d4a18a-59cb-4871-8781-cc1b7b7cd534",
    "causationId": "1a843dd0-b69d-4aa5-9262-7a639e188ec2",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.254Z"
  },
  {
    "hopId": "6be2a3c5-b41c-447c-b485-3bec5fcff5fc",
    "causationId": "09d4a18a-59cb-4871-8781-cc1b7b7cd534",
    "operation": "payment",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.265Z"
  },
  {
    "hopId": "b58bda59-9e5e-4e63-b084-d3b87e54e0c9",
    "causationId": "6be2a3c5-b41c-447c-b485-3bec5fcff5fc",
    "operation": "inventory",
    "status": "failed",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.278Z"
  },
  {
    "hopId": "4a21cf55-effb-48e8-ab1f-9a30ad4eb1df",
    "causationId": "b58bda59-9e5e-4e63-b084-d3b87e54e0c9",
    "operation": "payment_refund",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.291Z"
  },
  {
    "hopId": "3c6b26ce-934f-40fb-a76e-33f4fa25f92d",
    "causationId": "4a21cf55-effb-48e8-ab1f-9a30ad4eb1df",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.303Z"
  },
  {
    "hopId": "7ef693c4-5e60-4dc3-b7be-b382c19767b9",
    "causationId": "80634031-f0b2-41d6-b6ee-e6619efacd8d",
    "operation": "notify.send",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:42.310Z"
  }
]
```

Final state: `compensated`; code `inventory_unavailable`. Observed provider effects: `{"payment": ["charge", "refund"], "inventory": [], "shipping": [], "notification": ["notice"]}`.

Alert: none, by design: successful compensation leaves no stuck work.

Operator action: Inspect provider effects and notify the customer; do not refund again.

## Shipping timeout
Trigger: Configure shipping create delayMs=3500, exceeding the 2500 ms request timeout.

What the system does: The HTTP call times out; inventory_release precedes payment_refund. A timeout can leave an ambiguous shipment because shipping has no cancellation contract.

[Full observed record](../verification/03-shipping-timeout.json); correlationId `1603d902-170a-40e1-abd7-e99a63a415bb`.

```json
[
  {
    "hopId": "c1b4b3bb-c4d3-461a-96c3-aebe5cc924a1",
    "causationId": "63e17abe-7a8c-403a-b560-bbca96c4be74",
    "operation": "payment",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:43.599Z"
  },
  {
    "hopId": "367aea1d-6fb0-4255-9fd9-b51d39cd5087",
    "causationId": "c1b4b3bb-c4d3-461a-96c3-aebe5cc924a1",
    "operation": "inventory",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:43.605Z"
  },
  {
    "hopId": "94687d81-4c66-4303-8d3f-32aaa76bcec3",
    "causationId": "367aea1d-6fb0-4255-9fd9-b51d39cd5087",
    "operation": "shipping",
    "status": "timeout",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:43.611Z"
  },
  {
    "hopId": "9b900b51-a48b-4360-8720-017fdedd36c4",
    "causationId": "94687d81-4c66-4303-8d3f-32aaa76bcec3",
    "operation": "inventory_release",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:46.113Z"
  },
  {
    "hopId": "1a530f44-5f77-4c55-b2e9-ad559768f902",
    "causationId": "9b900b51-a48b-4360-8720-017fdedd36c4",
    "operation": "payment_refund",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:46.120Z"
  },
  {
    "hopId": "22630066-1fb0-4c5e-a38a-b4c67b24a6c4",
    "causationId": "1a530f44-5f77-4c55-b2e9-ad559768f902",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:46.126Z"
  },
  {
    "hopId": "8db2ca6b-412e-4ea3-825d-8314cc7b0b65",
    "causationId": "48ccc082-3b2f-470c-bff1-4743c45f9162",
    "operation": "notify.send",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:46.130Z"
  }
]
```

Final state: `compensated`; code `timeout`. Observed provider effects: `{"payment": ["charge", "refund"], "inventory": ["reservation", "release"], "shipping": [], "notification": ["notice"]}`.

Alert: none, by design: compensated work is terminal; shipping ambiguity is an operational limitation, not one of the seven predicates.

Operator action: Check shipping /admin/effects after the delayed call finishes before making another shipment.

## Refund fails and operator recovery
Trigger: Fail inventory reserve and payment refund with failMode=always.

What the system does: The payment succeeds, reservation fails and refund fails. Repair refund and call POST /sagas/:cid/compensate: only the outstanding refund runs. An idempotent repeat returns the saved body.

[Full observed record](../verification/04-refund-fails.json); correlationId `23b228f7-71db-4fb6-9df0-8dedf73350b0`.

```json
[
  {
    "hopId": "01953cf2-cca3-4325-976d-57aba14100f8",
    "causationId": "3223574c-df1f-44c7-a13c-6004d028c129",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.358Z"
  },
  {
    "hopId": "034d461c-4f8c-4858-9c5c-6691fa993ce5",
    "causationId": "fa4e6c2e-1b34-464e-9ba6-f5a66e3895e7",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.362Z"
  },
  {
    "hopId": "41cd7e61-293b-45e0-ae9b-e6a460ad1438",
    "causationId": "034d461c-4f8c-4858-9c5c-6691fa993ce5",
    "operation": "payment",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.368Z"
  },
  {
    "hopId": "be909631-1d5e-47e3-8815-2bf9c3d4f112",
    "causationId": "41cd7e61-293b-45e0-ae9b-e6a460ad1438",
    "operation": "inventory",
    "status": "failed",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.375Z"
  },
  {
    "hopId": "8f943f52-629b-45cc-8911-b3f59dfb65aa",
    "causationId": "be909631-1d5e-47e3-8815-2bf9c3d4f112",
    "operation": "payment_refund",
    "status": "failed",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.382Z"
  },
  {
    "hopId": "c48158fb-e1bc-490f-9ace-78f5bb0b1f3a",
    "causationId": "8f943f52-629b-45cc-8911-b3f59dfb65aa",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:47.391Z"
  }
]
```

Final state: `compensation_failed`; code `refund_failed`. Observed provider effects: `{"payment": ["charge"], "inventory": [], "shipping": [], "notification": []}`.

Alert: stuck_sagas while compensation_failed; it clears after the successful operator recovery.

Operator action: Repair payment refund, inspect effects, and invoke the compensation endpoint; see the recovered evidence.

[Recovery record](../verification/04-refund-fails-recovered.json): state `compensated`, code `inventory_unavailable`.

## First-step 503, retry, DLQ and replay
Trigger: Configure authorize failMode=always and failStatus=503.

What the system does: Three delivery attempts run through the retry path. The original order is parked in orders.dlq. Set failMode=never and POST /dlq/replay with this correlationId: fresh retry history permits completion.

[Full observed record](../verification/05-first-step-parked.json); correlationId `20075214-fa95-4077-b175-f08e9b3737c0`.

```json
[
  {
    "hopId": "7fc5bad2-0c01-469e-9574-210bb6e8c9ca",
    "causationId": "b19412b8-f3dd-4145-bc4b-df9657df24e2",
    "operation": "payment",
    "status": "failed",
    "attempt": 2,
    "startedAt": "2026-11-04T20:04:50.444Z"
  },
  {
    "hopId": "6da722bc-4bee-4abb-8291-dd5574c813a9",
    "causationId": "0e9e909e-efa6-44a6-8400-5f05bedb9157",
    "operation": "saga.retry",
    "status": "retried",
    "attempt": 2,
    "startedAt": "2026-11-04T20:04:50.454Z"
  },
  {
    "hopId": "4732e4a3-e5a4-4139-bfcb-65b6209d50f9",
    "causationId": "37e83fb5-135e-497f-8b58-80cb3d6da52d",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:51.461Z"
  },
  {
    "hopId": "65682777-b711-44b1-9642-7c964180ff3e",
    "causationId": "ccc45cb9-355a-495e-8b9e-8d76383dfd46",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:51.465Z"
  },
  {
    "hopId": "cdba8bd1-5ffb-4b22-8c89-794366b4c0f6",
    "causationId": "65682777-b711-44b1-9642-7c964180ff3e",
    "operation": "payment",
    "status": "failed",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:51.472Z"
  },
  {
    "hopId": "6bd9f8ef-af07-4317-bdc9-49195406e938",
    "causationId": "cdba8bd1-5ffb-4b22-8c89-794366b4c0f6",
    "operation": "saga.dead_letter",
    "status": "dead_lettered",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:51.483Z"
  },
  {
    "hopId": "357a581e-26d6-4a04-bb37-e376e5549d6e",
    "causationId": "6bd9f8ef-af07-4317-bdc9-49195406e938",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:51.493Z"
  }
]
```

Final state: `parked`; code `service_unavailable`. Observed provider effects: `{"payment": [], "inventory": [], "shipping": [], "notification": []}`.

Alert: dlq_not_empty until replay drains the parked message.

Operator action: Repair payment first, inspect GET /dlq, then replay only this correlationId.

[Recovery record](../verification/05-first-step-parked-recovered.json): state `completed`, code `service_unavailable`.

## Notice outage, DLQ and replay
Trigger: Decline payment and fail notification send with failMode=always.

What the system does: The saga remains failed; the notifier independently retries three times and parks its outcome. After send recovers, replay produces one notice without restarting the saga.

[Full observed record](../verification/06-notice-parked.json); correlationId `e01acc98-5427-4deb-be65-f90fbda9fb66`.

```json
[
  {
    "hopId": "db6ad06f-c384-468f-83c7-95f7a6fba529",
    "causationId": "fb64f259-daf6-413c-9eae-935d1ba89a0d",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:53.638Z"
  },
  {
    "hopId": "559731ea-d978-4a2f-8dfd-f26ffb559d4f",
    "causationId": "1fccdbb1-d197-4c61-a6c2-43e5b13f62fe",
    "operation": "notify.send",
    "status": "failed",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:53.642Z"
  },
  {
    "hopId": "7ad1151c-1c3c-4059-be69-ea1bbe040dc7",
    "causationId": "1fccdbb1-d197-4c61-a6c2-43e5b13f62fe",
    "operation": "notify.retry",
    "status": "retried",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:53.648Z"
  },
  {
    "hopId": "57b7eb79-dea3-4436-a8fd-51c5f5e56360",
    "causationId": "ca7891b9-bbd7-4f3f-96e9-2d0aa98e0415",
    "operation": "notify.send",
    "status": "failed",
    "attempt": 2,
    "startedAt": "2026-11-04T20:04:54.655Z"
  },
  {
    "hopId": "4f110bbe-8fa3-4506-afbd-a7200ca3f748",
    "causationId": "ca7891b9-bbd7-4f3f-96e9-2d0aa98e0415",
    "operation": "notify.retry",
    "status": "retried",
    "attempt": 2,
    "startedAt": "2026-11-04T20:04:54.658Z"
  },
  {
    "hopId": "ed6df9ff-2d50-405a-99f7-154097f00877",
    "causationId": "71f191cc-9c06-4e95-b469-c4268a6a38e7",
    "operation": "notify.send",
    "status": "failed",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:55.661Z"
  },
  {
    "hopId": "8809aff5-34b5-4cf3-9d8d-46959fb30644",
    "causationId": "ed6df9ff-2d50-405a-99f7-154097f00877",
    "operation": "notify.dead_letter",
    "status": "dead_lettered",
    "attempt": 3,
    "startedAt": "2026-11-04T20:04:55.664Z"
  }
]
```

Final state: `failed`; code `payment_declined`. Observed provider effects: `{"payment": [], "inventory": [], "shipping": [], "notification": []}`.

Alert: dlq_not_empty; normal processing does not turn notifier failure into a second checkout.

Operator action: Repair notification send and replay this correlationId via intake. Check notifications.queue origin and the notification effect log.

[Recovery record](../verification/06-notice-parked-recovered.json): state `failed`, code `payment_declined`.

## Orchestrator crash and operator compensation
Trigger: Delay shipping 2000 ms; after the inventory effect appears, docker kill cap-orchestrator, then docker start cap-orchestrator.

What the system does: The prior owner journal becomes needs_attention without automatic forward re-execution. An operator compensates confirmed inventory/payment steps. A provider call already in flight may still finish; its effects must be reviewed.

[Full observed record](../verification/07-orchestrator-crash.json); correlationId `cc908a34-4b1f-4fb7-b60d-56d849dff494`.

```json
[
  {
    "hopId": "c97ba96d-d345-4b2a-85f7-8798f27d0845",
    "causationId": "c13b35f8-e4d2-4c46-b51b-16ee2f3f88e0",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:57.560Z"
  },
  {
    "hopId": "ea07e776-0199-45c1-9da0-ae63c4f23828",
    "causationId": "6b178c26-5395-4c1c-b8b3-c3454858fca3",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:57.565Z"
  },
  {
    "hopId": "ac5d365c-2fd6-4eb6-b73b-e0d302017367",
    "causationId": "ea07e776-0199-45c1-9da0-ae63c4f23828",
    "operation": "payment",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:57.573Z"
  },
  {
    "hopId": "b48f395e-4867-4f7e-972c-9eb0211031c3",
    "causationId": "ac5d365c-2fd6-4eb6-b73b-e0d302017367",
    "operation": "inventory",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:57.583Z"
  },
  {
    "hopId": "40f2b646-ba80-4f11-aba2-5d346623b845",
    "causationId": "c13b35f8-e4d2-4c46-b51b-16ee2f3f88e0",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:58.834Z"
  },
  {
    "hopId": "deabe48b-e206-40e8-9080-05c46f7f6e46",
    "causationId": "5fcfff47-33ce-4602-b50f-5cfa02822914",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:04:58.836Z"
  }
]
```

Final state: `needs_attention`; code `none`. Observed provider effects: `{"payment": ["charge"], "inventory": ["reservation"], "shipping": [], "notification": []}`.

Alert: stuck_sagas after restart. saga_consumer_missing can fire while the process is stopped.

Operator action: Inspect provider effects, especially shipping, then POST /sagas/:cid/compensate. This is not a shipment cancellation API.

[Recovery record](../verification/07-orchestrator-crash-recovered.json): state `compensated`, code `operator_compensated`.

## Broker restart
Trigger: docker restart cap-rabbitmq; wait for healthy and poll each service /health, then submit a fresh order.

What the system does: All four services reconnect without process/container restart and the next order completes. Evidence compares their restart counts before and after.

[Full observed record](../verification/08-broker-restart.json); correlationId `84a02b9c-6985-4fcc-abcf-e895e8da7345`.

```json
[
  {
    "hopId": "b38fcfa5-54d2-4ede-ba63-222edbf43b64",
    "causationId": "14705dde-874d-4d9b-8a26-67a3f813a635",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.838Z"
  },
  {
    "hopId": "9c297b4a-dda3-42e2-8d3b-650b774cdbc0",
    "causationId": "f4d98e8b-4115-4638-9cfd-c5c05ef5847a",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.844Z"
  },
  {
    "hopId": "5f08797d-c001-44c2-bc4e-fc69a4e97242",
    "causationId": "9c297b4a-dda3-42e2-8d3b-650b774cdbc0",
    "operation": "payment",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.854Z"
  },
  {
    "hopId": "a7a3f8ae-f26e-41ae-9172-660f1a1a0da9",
    "causationId": "5f08797d-c001-44c2-bc4e-fc69a4e97242",
    "operation": "inventory",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.865Z"
  },
  {
    "hopId": "d5ec62b4-b5b2-484d-ae1d-473fb8db2d46",
    "causationId": "a7a3f8ae-f26e-41ae-9172-660f1a1a0da9",
    "operation": "shipping",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.878Z"
  },
  {
    "hopId": "62d84dca-a5d4-41a3-aeec-e9def66bb74f",
    "causationId": "d5ec62b4-b5b2-484d-ae1d-473fb8db2d46",
    "operation": "notification",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.888Z"
  },
  {
    "hopId": "64d07462-20f7-4672-944d-f655dfcc097b",
    "causationId": "62d84dca-a5d4-41a3-aeec-e9def66bb74f",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:26.898Z"
  }
]
```

Final state: `completed`; code `none`. Observed provider effects: `{"payment": ["charge"], "inventory": ["reservation"], "shipping": ["shipment"], "notification": ["notice"]}`.

Alert: Consumer-missing alerts may occur during recovery; metrics itself returns 503 when the broker is unavailable. No alert remains once all consumers reconnect.

Operator action: Wait for broker health, check each /health and /ops/metrics; restart service containers only if automatic recovery fails.

## New HTTP key, same business order
Trigger: Complete one fresh order, then submit the identical business order with a new Idempotency-Key.

What the system does: A new correlationId is accepted, but the business-key ledger publishes duplicate with duplicateOf pointing to the first correlation. Provider effect logs still contain only the first purchase.

[Full observed record](../verification/09-business-duplicate.json); correlationId `e3304b38-2321-490c-b03f-c5e321cb0c24`.

```json
[
  {
    "hopId": "deac7b73-8d6b-4af2-8482-7d35ac36f819",
    "causationId": "8055ec48-2df5-4d24-80af-bb7d15f100a4",
    "operation": "saga.consume",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:29.106Z"
  },
  {
    "hopId": "6923aa2a-b8c0-450d-8a0b-0dc2abda819e",
    "causationId": "6d37cfbe-a9e2-4a8e-91e1-ce777cbca0e8",
    "operation": "saga.outcome",
    "status": "success",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:29.108Z"
  }
]
```

Final state: `duplicate`; code `none`. Observed provider effects: `{"payment": ["charge"], "inventory": ["reservation"], "shipping": ["shipment"], "notification": ["notice"]}`.

Alert: none, by design: business deduplication is an ordinary terminal outcome.

Operator action: Retrieve the original order via duplicateOf. Use a new orderId only for a genuinely new purchase.

## Malformed messages with and without correlationId
Trigger: publish `{ not json` to orders.exchange twice, once with a correlation header and once without it. Both are quarantined without retrying business work. Original bytes and headers are retained in orders.invalid.

Real trace excerpt for the correlated message:

```json
[
  {
    "hopId": "a9c4b206-ad72-4bd7-bda4-3763c37bf256",
    "correlationId": "eae1cc18-d61a-46e1-9d10-f91518d27247",
    "causationId": "e1c18409-26e6-4544-8389-491bab9370ae",
    "service": "orchestrator",
    "operation": "invalid.quarantine",
    "status": "quarantined",
    "attempt": 1,
    "startedAt": "2026-11-04T20:05:30.205Z",
    "finishedAt": "2026-11-04T20:05:30.205Z",
    "durationMs": 0
  }
]
```

Without a correlation header, no trace is emitted by design; assigning an invented identity would misrepresent the message. Final state: no order-status record, no provider call; both messages are quarantined. Alert: invalid_not_empty. Operator action: inspect the original bytes and fix the producer; the replay endpoint never reads orders.invalid. See [with-header evidence](../verification/10-invalid-True.json) and [without-header evidence](../verification/10-invalid-False.json).
