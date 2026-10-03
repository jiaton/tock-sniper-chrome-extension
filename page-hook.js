// Tock Sniper — MAIN-world hook (runs at document_start, before Tock's own scripts)
// Records the X-Tock-* headers Tock's frontend attaches to its own API calls
// (session, auth JWT, CSRF, fingerprint, build number, scope) so content.js can
// send the lock request with exactly the same headers.

(() => {
  const proto = XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSetHeader = proto.setRequestHeader;
  const origSend = proto.send;

  proto.open = function (method, url) {
    this.__tsUrl = String(url);
    this.__tsHeaders = {};
    return origOpen.apply(this, arguments);
  };

  proto.setRequestHeader = function (name, value) {
    if (this.__tsHeaders && /^x-tock-/i.test(name)) this.__tsHeaders[name.toLowerCase()] = value;
    return origSetHeader.apply(this, arguments);
  };

  proto.send = function () {
    try {
      if (/\/api\//.test(this.__tsUrl || "") && this.__tsHeaders && Object.keys(this.__tsHeaders).length) {
        const prev = JSON.parse(document.documentElement.dataset.tockSniperHeaders || "{}");
        document.documentElement.dataset.tockSniperHeaders = JSON.stringify({ ...prev, ...this.__tsHeaders });
      }
    } catch {}
    return origSend.apply(this, arguments);
  };
})();
