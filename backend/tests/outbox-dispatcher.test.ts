import { describe, it, expect, vi, beforeEach } from "vitest";
import { OutboxDispatcher } from "../src/services/outbox-dispatcher.service.js";
import { createDomainEvent } from "../src/services/event-publisher.service.js";
import { loadMessagingConfig } from "../src/config/messaging.js";

const tripId = "11111111-1111-4111-8111-111111111111";
const payload = {
  clientId: "22222222-2222-4222-8222-222222222222",
  driverId: "33333333-3333-4333-8333-333333333333",
};

const arrived = { id: 1, envelope: createDomainEvent("DriverArrived", tripId, payload) };
const started = { id: 2, envelope: createDomainEvent("TripStarted", tripId, payload) };

describe("Despachador de la outbox (unitario)", () => {
  let outbox: any;
  let transport: any;

  beforeEach(() => {
    outbox = {
      findPending: vi.fn().mockResolvedValue([arrived, started]),
      markPublished: vi.fn(),
      markFailed: vi.fn(),
    };
    transport = { publish: vi.fn() };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("envia los pendientes en orden, cada uno con su routing key, y los marca como enviados", async () => {
    const sent = await new OutboxDispatcher(outbox, transport).dispatchPending();

    expect(sent).toBe(2);
    expect(transport.publish.mock.calls).toEqual([
      ["trip.arrived", arrived.envelope],
      ["trip.started", started.envelope],
    ]);
    expect(outbox.markPublished.mock.calls).toEqual([[1], [2]]);
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  it("si un envio falla, lo anota, no lo marca como enviado y no sigue con el siguiente", async () => {
    transport.publish.mockRejectedValue(new Error("broker caido"));

    const sent = await new OutboxDispatcher(outbox, transport).dispatchPending();

    expect(sent).toBe(0);
    expect(transport.publish).toHaveBeenCalledTimes(1);
    expect(outbox.markFailed).toHaveBeenCalledWith(1, "broker caido");
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it("con el broker caido avisa una sola vez y envia cuando vuelve", async () => {
    transport.publish.mockRejectedValueOnce(new Error("broker caido")).mockRejectedValueOnce(new Error("broker caido"));
    const dispatcher = new OutboxDispatcher(outbox, transport);

    await dispatcher.dispatchPending();
    await dispatcher.dispatchPending();
    const sent = await dispatcher.dispatchPending();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(sent).toBe(2);
  });

  it("sin RABBITMQ_URL no hay configuracion; con ella usa el exchange m6.events", () => {
    expect(loadMessagingConfig({})).toBeUndefined();
    expect(loadMessagingConfig({ RABBITMQ_URL: "  " })).toBeUndefined();
    expect(loadMessagingConfig({ RABBITMQ_URL: "amqp://localhost" })).toEqual({
      url: "amqp://localhost",
      exchange: "m6.events",
    });
  });
});