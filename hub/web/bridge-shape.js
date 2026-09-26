// The one description of the `window.api` object PiPulse's pages use. Leaves are channel names
// (a leading "!" would be an event stream). kit/renderer/webbridge.js turns this into fetch calls;
// hub/web.py (kit channels) and register_channels() in hub/hub.py (PiPulse's) answer them.
// tests/test_web.py checks every channel here is served and nothing is served without being listed.
(function (root, shape) {
  if (typeof module !== 'undefined' && module.exports) module.exports = shape;
  else root.API_SHAPE = shape;
})(typeof self !== 'undefined' ? self : this, {
  // kit
  appInfo: 'app:info',
  settings: { get: 'settings:get', set: 'settings:set', replace: 'settings:replace' },
  update: { check: 'update:check', status: 'update:status', install: 'update:install' },
  sys: { stats: 'sys:stats' },
  db: { stats: 'db:stats' },
  logTail: 'log:tail',
  notifyTest: 'notify:test',
  prefs: { get: 'prefs:get', set: 'prefs:set' },
  security: { me: 'security:me', status: 'security:status', changePassword: 'security:changePassword', totpSetup: 'security:totpSetup', totpEnable: 'security:totpEnable', totpDisable: 'security:totpDisable', setOptions: 'security:setOptions', revoke: 'security:revoke', revokeOthers: 'security:revokeOthers', users: 'security:users', addUser: 'security:addUser', setRole: 'security:setRole', resetPassword: 'security:resetPassword', deleteUser: 'security:deleteUser', tlsEnable: 'security:tlsEnable' },
  status: { info: 'status:info', rotate: 'status:rotate' },
  dialog: { pickFolder: 'dialog:pickFolder', pickFile: 'dialog:pickFile' },
  shell: { open: 'shell:open', openExternal: 'shell:openExternal', showItem: 'shell:showItem' },
  // PiPulse
  fleet: { state: 'fleet:state', install: 'fleet:install' },
  pi: { get: 'pi:get', history: 'pi:history', action: 'pi:action', power: 'pi:power', label: 'pi:label', watch: 'pi:watch', forget: 'pi:forget' },
  events: { list: 'events:list' },
  hub: { settings: 'hub:settings', setSettings: 'hub:setSettings', guards: 'hub:guards' },
  nas: { view: 'nas:view', run: 'nas:run' },
  hubUpdate: { view: 'hubupdate:view', check: 'hubupdate:check', hub: 'hubupdate:hub', clients: 'hubupdate:clients' },
});
