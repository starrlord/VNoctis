const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch(apiToken, path, options = {}) {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!json.success) {
    const msg = json.errors?.[0]?.message ?? `Cloudflare API error on ${path}`;
    throw new Error(msg);
  }
  return json;
}

export async function ensureBucket(apiToken, accountId, bucketName) {
  try {
    await cfFetch(apiToken, `/accounts/${accountId}/r2/buckets/${bucketName}`);
    return 'already_exists';
  } catch (err) {
    // Bucket not found — create it
    if (!err.message.toLowerCase().includes('not found') && !err.message.toLowerCase().includes('doesn\'t exist') && !err.message.toLowerCase().includes('does not exist')) {
      throw err;
    }
  }

  await cfFetch(apiToken, `/accounts/${accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name: bucketName }),
  });
  return 'created';
}

export async function getZoneId(apiToken, hostname) {
  const parts = hostname.split('.');
  const rootDomain = parts.slice(-2).join('.');
  const res = await cfFetch(apiToken, `/zones?name=${rootDomain}`);
  const zone = res.result?.[0];
  if (!zone) throw new Error(`Zone '${rootDomain}' not found in this Cloudflare account.`);
  return zone.id;
}

export async function ensureCustomDomain(apiToken, accountId, bucketName, hostname) {
  const listRes = await cfFetch(
    apiToken,
    `/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`
  );
  const existing = listRes.result?.domains ?? [];
  if (existing.some((d) => d.domain === hostname && d.status === 'active')) {
    return 'already_connected';
  }

  const zoneId = await getZoneId(apiToken, hostname);
  await cfFetch(apiToken, `/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`, {
    method: 'POST',
    body: JSON.stringify({ domain: hostname, enabled: true, zoneId }),
  });
  return 'connected';
}

export async function ensureRewriteRule(apiToken, zoneId, hostname) {
  const phasePath = `/zones/${zoneId}/rulesets/phases/http_request_transform/entrypoint`;
  const targetExpression = `(http.host eq "${hostname}" and http.request.uri.path eq "/")`;

  let existingRules = [];
  try {
    const res = await cfFetch(apiToken, phasePath);
    existingRules = res.result?.rules ?? [];
  } catch (err) {
    // 404 means ruleset doesn't exist yet — start with empty rules
    if (!err.message.includes('not found') && !err.message.includes('Could not find')) {
      throw err;
    }
  }

  if (existingRules.some((r) => r.expression === targetExpression)) {
    return 'already_exists';
  }

  const newRule = {
    description: 'VNoctis: rewrite / to /index.html for R2 gallery',
    expression: targetExpression,
    action: 'rewrite',
    action_parameters: {
      uri: {
        path: { type: 'static', value: '/index.html' },
      },
    },
    enabled: true,
  };

  await cfFetch(apiToken, phasePath, {
    method: 'PUT',
    body: JSON.stringify({ rules: [...existingRules, newRule] }),
  });
  return 'created';
}
