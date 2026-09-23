#!/usr/bin/env node
/**
 * Print the first free TCP port on 127.0.0.1 in [from, to].
 *
 *   node tools/free-port.cjs 3001 3020      → prints e.g. 3002, exit 0
 *                                            → nothing on stdout, exit 2 if all busy
 *
 * For launchers that may run beside another AEON (a USB drive plugged into a
 * machine that runs its own). Every kernel module reads PORT once at load, so
 * the port has to be chosen before boot, not negotiated after a collision —
 * see src/kernel/portConflict.cjs. There is a window between this probe and
 * the server's listen(); losing it produces the kernel's clear
 * "port already in use" stop, never a kill.
 */
'use strict';

const net = require('net');

function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  const from = Number(process.argv[2]) || 3001;
  const to = Number(process.argv[3]) || from + 19;
  for (let p = from; p <= to; p++) {
    if (await isFree(p)) { process.stdout.write(`${p}\n`); return; }
  }
  process.stderr.write(`no free port between ${from} and ${to}\n`);
  process.exitCode = 2;
}

main();
