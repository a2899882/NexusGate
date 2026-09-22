'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = [
  'users', 'servers', 'agents', 'enrollmentTokens', 'customers', 'chains',
  'deployments', 'jobs', 'activity', 'observations'
];

function emptyData() {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    settings: {
      brandName: 'NexusGate',
      sessionHours: 12,
      observationTtlMinutes: 10,
      activityRetentionDays: 30,
      completedJobRetentionDays: 7
    },
    users: [], servers: [], agents: [], enrollmentTokens: [], customers: [],
    chains: [], deployments: [], jobs: [], activity: [], observations: []
  };
}

class Store {
  constructor(file) {
    this.file = path.resolve(file);
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      this.data = JSON.parse(raw);
      this.#validate(this.data);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = emptyData();
      await this.#persist(this.data);
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async transaction(mutator) {
    const operation = async () => {
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      this.#validate(draft);
      await this.#persist(draft);
      this.data = draft;
      return result;
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  async replace(next) {
    return this.transaction((draft) => {
      const copy = structuredClone(next);
      this.#validate(copy);
      for (const key of Object.keys(draft)) delete draft[key];
      Object.assign(draft, copy);
    });
  }

  #validate(data) {
    if (!data || data.schemaVersion !== 1 || !data.settings) {
      throw new Error('Unsupported or corrupt NexusGate data file');
    }
    for (const name of COLLECTIONS) {
      if (!Array.isArray(data[name])) throw new Error(`Invalid collection: ${name}`);
    }
  }

  async #persist(data) {
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = `${JSON.stringify(data, null, 2)}\n`;
    await fs.promises.writeFile(temp, body, { mode: 0o600 });
    await fs.promises.rename(temp, this.file);
    await fs.promises.chmod(this.file, 0o600);
  }
}

module.exports = { Store, emptyData };
