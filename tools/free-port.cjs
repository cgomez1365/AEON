#!/usr/bin/env node
/**
 * Print the first free TCP port on loopback in [from, to]: 127.0.0.1 binds and
 * nothing answers there on 127.0.0.1 or ::1 (see isFree).
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
 *
 * Also required by launch.js (the desktop install's launcher), which needs the
 * same answer in-process: it used to assume 3001 and, with another program
 * there, opened that program's page in the browser (A046, 2026-09-30).
 */
'use strict';

const net = require('net');

function canBind(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// Does anything accept a connection there? Refused, unreachable (no IPv6) or
// no answer in time all count as no: Windows takes a second or two to refuse
// on loopback, and a port that is in use answers at once.
function answers(port, host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const c = net.connect({ port, host });
    const done = (v) => { c.destroy(); resolve(v); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    c.setTimeout(timeoutMs, () => done(false));
  });
}

// A bind on 127.0.0.1 alone said "free" beside a program listening the
// Node-default way (listen(port): '::', both families). macOS lets the bind
// through, AEON then took 127.0.0.1 while the browser's `localhost` reached
// the other program over ::1 (review 2026-09-30). So free means: 127.0.0.1
// binds AND nothing answers on 127.0.0.1 or ::1.
async function isFree(port) {
  if (!(await canBind(port, '127.0.0.1'))) return false;
  const [v4, v6] = await Promise.all([answers(port, '127.0.0.1'), answers(port, '::1')]);
  return !v4 && !v6;
}

/** The first free port in [from, to], or null when every one is taken. */
async function firstFreePort(from = 3001, to = from + 19, probe = isFree) {
  for (let p = from; p <= to; p++) {
    if (await probe(p)) return p;
  }
  return null;
}

async function main() {
  const from = Number(process.argv[2]) || 3001;
  const to = Number(process.argv[3]) || from + 19;
  const port = await firstFreePort(from, to);
  if (port != null) { process.stdout.write(`${port}\n`); return; }
  process.stderr.write(`no free port between ${from} and ${to}\n`);
  process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { isFree, firstFreePort };
