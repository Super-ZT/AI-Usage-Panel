'use strict';

/**
 * Runtime configuration and enrollment state.
 *
 * The package template is read-only. User overrides and enrollment credentials
 * live under operating-system per-user directories, never beside packaged code.
 */

const fs = require('fs');
const path = require('path');

const appPaths = require('./paths');

function readJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (_) { return fallback; }
}

function merge(base, override) {
  const result = Object.assign({}, base || {});
  for (const [key, value] of Object.entries(override || {})) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)
        && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = merge(result[key], value);
    } else result[key] = value;
  }
  return result;
}

function userConfigPath() {
  return process.env.USAGE_PANEL_CONFIG || path.join(appPaths.configDir(), 'config.json');
}

function enrollmentPath() {
  return process.env.USAGE_PANEL_ENROLLMENT_FILE || path.join(appPaths.dataDir(), 'enrollment.json');
}

function load(root) {
  const defaults = readJson(path.join(root, 'config.example.json'), {});
  const user = readJson(userConfigPath(), {});
  const enrollment = readJson(enrollmentPath(), {});
  const config = merge(defaults, user);
  if (enrollment && enrollment.sync) config.sync = merge(config.sync, enrollment.sync);
  return config;
}

function writePrivateJson(filename, value) {
  const directory = path.dirname(filename);
  appPaths.ensurePrivateDir(directory);
  const temporary = filename + '.' + process.pid + '.' + Date.now() + '.tmp';
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, flags, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, filename);
    try { fs.chmodSync(filename, 0o600); } catch (_) { /* Windows ACLs apply instead */ }
  } catch (err) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* preserve original error */ }
    }
    try { fs.unlinkSync(temporary); } catch (_) { /* temp may not have been created */ }
    throw err;
  }
}

function saveEnrollment(values) {
  if (!values || typeof values.endpoint !== 'string' || !values.endpoint
      || typeof values.deviceCredential !== 'string' || !values.deviceCredential
      || typeof values.deviceId !== 'string' || !values.deviceId) {
    throw new Error('complete enrollment state is required');
  }
  writePrivateJson(enrollmentPath(), {
    version: 1,
    sync: {
      enabled: true,
      endpoint: values.endpoint,
      deviceCredential: values.deviceCredential,
      deviceId: values.deviceId,
      allowInsecure: !!values.allowInsecure
    }
  });
  return enrollmentPath();
}

module.exports = { enrollmentPath, load, merge, saveEnrollment, userConfigPath, writePrivateJson };
