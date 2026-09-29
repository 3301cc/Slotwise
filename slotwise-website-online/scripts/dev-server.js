"use strict";
// Lokal: node scripts/dev-server.js [port] – nutzt denselben Server wie server/standalone.js.
process.env.PORT = process.argv[2] || process.env.PORT || 3000;
require("../server/standalone").server.listen(Number(process.env.PORT), () => console.log(`Slotwise lokal: http://localhost:${process.env.PORT}`));
