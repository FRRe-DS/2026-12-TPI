import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";
import { prisma } from "../../src/config/database.js";
import { OutboxRepository } from "../../src/repositories/outbox.repository.js";
import { OutboxDispatcher } from "../../src/services/outbox-dispatcher.service.js";
import { RabbitMqPublisher } from "../../src/services/rabbitmq-publisher.service.js";
import { startServer, stopServer, resetDatabase, createTrip, advanceTrip } from "./helpers.js";

// A propósito NO se usa RABBITMQ_URL: así nunca se mandan eventos de prueba a un broker compartido.
const BROKER_URL = process.env.TEST_RABBITMQ_URL ?? "amqp://m6:m6_dev@localhost:5672";
/** Exchange propio de los tests, separado del real (m6.events). */
const EXCHANGE = "m6.events.test";
/** Puerto donde no escucha nadie: sirve para simular que no hay conexión. */
const UNREACHABLE_URL = "amqp://m6:m6_dev@localhost:1";

/** Filas de la outbox en el orden en que se envían. */
const outbox = () => prisma.outboxEvent.findMany({ orderBy: { id: "asc" } });

describe("Eventos contra un RabbitMQ real (integracion)", () => {
  let connection: ChannelModel | undefined;
  let channel: Channel;
  let queue: string;
  let received: ConsumeMessage[];
  let publisher: RabbitMqPublisher;
  let unreachable: RabbitMqPublisher;

  const dispatcherFor = (transport: RabbitMqPublisher) =>
    new OutboxDispatcher(new OutboxRepository(prisma), transport);

  beforeAll(async () => {
    await startServer();
    try {
      connection = await amqp.connect(BROKER_URL, { timeout: 5000 });
    } catch (err) {
      throw new Error(
        "No se pudo conectar a RabbitMQ. Levantalo con: docker compose up -d db rabbitmq\n" +
          String(err)
      );
    }
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
  });

  afterAll(async () => {
    if (connection) {
      await channel.deleteExchange(EXCHANGE);
      await connection.close();
    }
    await stopServer();
  });

  beforeEach(async () => {
    await resetDatabase();
    // El despachador escribe en consola cada envío y cada fallo; se silencia para no ensuciar la salida.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    publisher = new RabbitMqPublisher({ url: BROKER_URL, exchange: EXCHANGE });
    unreachable = new RabbitMqPublisher({ url: UNREACHABLE_URL, exchange: EXCHANGE }, 1000);

    // Cola temporal de un consumidor de prueba, suscripta a todos los eventos de viajes.
    received = [];
    queue = (await channel.assertQueue("", { exclusive: true })).queue;
    await channel.bindQueue(queue, EXCHANGE, "trip.#");
    await channel.consume(
      queue,
      (message) => {
        if (message) received.push(message);
      },
      { noAck: true }
    );
  });

  afterEach(async () => {
    await publisher.close();
    await unreachable.close();
    await channel.deleteQueue(queue);
    vi.restoreAllMocks();
  });

  it("los eventos llegan en orden, con su routing key, y quedan marcados como enviados", async () => {
    const { trip } = await createTrip();
    await advanceTrip(trip, "COMPLETED");
    const dispatcher = dispatcherFor(publisher);

    expect(await dispatcher.dispatchPending()).toBe(4);
    await vi.waitFor(() => expect(received).toHaveLength(4));

    expect(received.map((m) => m.fields.routingKey)).toEqual([
      "trip.created",
      "trip.arrived",
      "trip.started",
      "trip.completed",
    ]);

    const rows = await outbox();
    expect(received.map((m) => JSON.parse(m.content.toString()))).toEqual(
      rows.map((r) => r.envelope)
    );
    expect(received.map((m) => m.properties.messageId)).toEqual(rows.map((r) => r.eventId));
    for (const message of received) {
      expect(message.properties.contentType).toBe("application/json");
      expect(message.properties.deliveryMode).toBe(2); // persistente
    }
    for (const row of rows) {
      expect(row.publishedAt).not.toBeNull();
      expect(row.attempts).toBe(1);
    }

    // Una segunda pasada no vuelve a enviar nada.
    expect(await dispatcher.dispatchPending()).toBe(0);
  });

  it("sin conexion el evento queda pendiente y sale en un reintento", async () => {
    await createTrip();

    expect(await dispatcherFor(unreachable).dispatchPending()).toBe(0);

    const [failed] = await outbox();
    expect(failed!.publishedAt).toBeNull();
    expect(failed!.attempts).toBe(1);
    expect(failed!.lastError).toBeTruthy();

    expect(await dispatcherFor(publisher).dispatchPending()).toBe(1);
    await vi.waitFor(() => expect(received).toHaveLength(1));

    const [sent] = await outbox();
    expect(sent!.publishedAt).not.toBeNull();
    expect(sent!.attempts).toBe(2);
    expect(sent!.lastError).toBeNull();
  });

  it("checkConnection responde con el broker encendido y falla si no hay conexion", async () => {
    await expect(publisher.checkConnection()).resolves.toBeUndefined();
    await expect(unreachable.checkConnection()).rejects.toThrow();
  });

  it("dos pedidos simultaneos comparten una sola conexion", async () => {
    const connect = vi.spyOn(amqp, "connect");

    await Promise.all([publisher.checkConnection(), publisher.checkConnection()]);

    expect(connect).toHaveBeenCalledTimes(1);
  });
});