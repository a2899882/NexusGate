'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { Orchestrator } = require('../lib/orchestrator');

test('job failures redact a Reality secret and stale completions cannot overwrite a retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusgate-jobs-'));
  try {
    const store = await new Store(path.join(dir, 'data.json')).init();
    await store.transaction((data) => {
      data.jobs.push({ id:'job_running', status:'running', deploymentId:'dep_missing', action:'apply_resource',
        serverId:'srv_test', payload:{}, attempts:1 });
      data.jobs.push({ id:'job_requeued', status:'queued', deploymentId:'dep_missing', action:'apply_resource',
        serverId:'srv_test', payload:{}, attempts:2 });
    });
    const orchestrator = new Orchestrator(store);
    await orchestrator.completeJob('job_running', false, {}, 'PrivateKey: should_not_persist Password (PublicKey): public_value');
    assert.match(store.data.jobs[0].error, /PrivateKey: \[REDACTED\]/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), /should_not_persist/);
    await assert.rejects(() => orchestrator.completeJob('job_requeued', true), (error) => error.statusCode === 409);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
