import { parentPort, workerData } from 'node:worker_threads';
import { parsePdf } from '../services/paper-verification.mjs';
try { parentPort.postMessage({ parsed: await parsePdf(Buffer.from(workerData)) }); }
catch { parentPort.postMessage({ error: 'PDF_PARSE_FAILED' }); }
