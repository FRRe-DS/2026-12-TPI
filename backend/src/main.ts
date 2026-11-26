// La instrumentacion debe iniciarse antes de cargar http y el cliente Prisma.
import "./telemetria/instrumentacion.js";

void import("./explorer.js");
