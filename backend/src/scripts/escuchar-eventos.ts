/**
 * Herramienta de desarrollo: se suscribe a todos los eventos de viajes y los muestra en la consola,
 * como lo haría un módulo consumidor. Uso: npm run eventos:escuchar (cortar con Ctrl+C).
 */
import "dotenv/config";
import amqp from "amqplib";
import { loadMessagingConfig } from "../config/messaging.js";

async function main() {
  const config = loadMessagingConfig();
  if (!config) {
    throw new Error("Falta RABBITMQ_URL en backend/.env");
  }

  const connection = await amqp.connect(config.url);
  connection.on("error", (err) => console.error("Error de conexión:", err.message));
  connection.on("close", () => process.exit(1));

  const channel = await connection.createChannel();
  await channel.assertExchange(config.exchange, "topic", { durable: true });
  // Cola temporal y exclusiva: se borra sola al cortar el script.
  const { queue } = await channel.assertQueue("", { exclusive: true });
  await channel.bindQueue(queue, config.exchange, "trip.#");

  await channel.consume(
    queue,
    (message) => {
      if (!message) return;
      console.log(`\n📩 ${message.fields.routingKey}`);
      console.log(message.content.toString());
    },
    { noAck: true }
  );

  console.log(`👂 Escuchando "trip.#" en el exchange ${config.exchange}. Ctrl+C para salir.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});