import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { MessagingConfig } from "../config/messaging.js";
import type { AnyDomainEvent } from "./event-publisher.service.js";

/** Lo que el despachador necesita para enviar un evento (en los tests se reemplaza por uno falso). */
export interface EventTransport {
  publish(routingKey: string, event: AnyDomainEvent): Promise<void>;
}

/** Plazo máximo para conectarse y para recibir la confirmación del broker. */
const TIMEOUT_MS = 5000;

/**
 * Publica eventos en RabbitMQ y espera la confirmación del broker (RNF-10).
 * Se conecta recién al primer envío; si la conexión se cae, el envío siguiente vuelve a conectar.
 */
export class RabbitMqPublisher implements EventTransport {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private opening: Promise<ConfirmChannel> | null = null;

  constructor(
    private readonly config: MessagingConfig,
    private readonly timeoutMs: number = TIMEOUT_MS
  ) {}

  private openChannel(): Promise<ConfirmChannel> {
    if (this.channel) return Promise.resolve(this.channel);

    // Si ya se está conectando, se espera ese mismo intento: así nunca se abren dos conexiones.
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<ConfirmChannel> {

    const connection = await amqp.connect(this.config.url, { timeout: this.timeoutMs });
    this.connection = connection;
    // Sin un listener de "error", un corte de la conexión tiraría abajo todo el proceso.
    connection.on("error", () => {});
    connection.on("close", () => this.forget(connection));

    try {
      const channel = await connection.createConfirmChannel();
      channel.on("error", () => {});
      channel.on("close", () => void this.close());
      await channel.assertExchange(this.config.exchange, "topic", { durable: true });
      this.channel = channel;
      return channel;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  /** Olvida una conexión que se cerró, salvo que ya haya otra nueva en su lugar. */
  private forget(connection: ChannelModel): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.channel = null;
  }

  /** Resuelve solo cuando el broker confirmó que recibió el mensaje. */
  async publish(routingKey: string, event: AnyDomainEvent): Promise<void> {
    const channel = await this.openChannel();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.close();
        reject(new Error("RabbitMQ no confirmó el mensaje a tiempo"));
      }, this.timeoutMs);

      channel.publish(
        this.config.exchange,
        routingKey,
        Buffer.from(JSON.stringify(event)),
        {
          persistent: true,
          contentType: "application/json",
          messageId: event.eventId,
          type: event.eventType,
          correlationId: event.correlationId,
        },
        (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  /** Falla si el broker no responde (lo usa /health/details, RNF-14). */
  async checkConnection(): Promise<void> {
    const channel = await this.openChannel();
    await channel.checkExchange(this.config.exchange);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    // Cerrar una conexión que ya está cerrada da error y no importa.
    await connection?.close().catch(() => {});
  }
}