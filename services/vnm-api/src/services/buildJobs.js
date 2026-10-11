import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildFailureStatus(game) {
  if (game?.webBuildPath && game.builtAt) {
    try { if ((await stat(join(process.env.WEB_BUILDS_PATH || '/web-builds', game.directoryName, 'index.html'))).isFile()) return 'built'; }
    catch { /* No prior playable output. */ }
  }
  return 'failed';
}

export function registerBuildJobs(app) {
  const url = process.env.BUILDER_URL || 'http://vnm-builder:3002';
  app.jobRunner.register('build', async (job, input, context) => {
    const game = await app.prisma.game.findUnique({ where: { id: job.gameId } });
    if (!game || game.buildJobId !== job.id) throw new Error('Game removed or build superseded.');
    await context.progress({ stage: 'builder-queued' });
    await context.log('[queued] Waiting for the build worker.');
    let response;
    try { response = await fetch(`${url}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, gameId: job.gameId, gamePath: game.directoryPath, compressAssets: Boolean(input.compressAssets), forceRecompress: Boolean(input.forceRecompress) }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]) }); }
    catch (error) {
      context.signal.throwIfAborted();
      await context.log('[queued] Worker acknowledgement unavailable; checking durable worker state before retry.');
      return;
    }
    if (!response.ok) throw new Error(`Builder rejected request (${response.status}): ${await response.text()}`);
  });
}
