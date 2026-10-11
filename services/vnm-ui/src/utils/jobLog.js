export function appendLogChunk(text, pending = '', done = false) {
  const parts = (pending + text).split(/\r\n|\r|\n/);
  const remainder = parts.pop() || '';
  if (done && remainder) parts.push(remainder);
  return { lines: parts.map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).filter(line => line.trim()), pending: done ? '' : remainder };
}

export const stageLabels = {
  queued: 'Queued', preparing: 'Preparing game files', 'builder-queued': 'Waiting for build worker',
  downloading: 'Downloading archive', inspecting: 'Inspecting archive', extracting: 'Extracting archive',
  'unpacking-rpa': 'Unpacking game assets', optimizing: 'Optimizing images', packaging: 'Building web distribution',
  publishing: 'Publishing completed files', scanning: 'Registering game', building: 'Building',
  done: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
