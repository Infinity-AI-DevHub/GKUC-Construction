const {test}=require('node:test');
const assert=require('node:assert/strict');
const {serverOrigin,requestTarget,assetPath,navigationAllowed,externalAllowed}=require('../src/core.cjs');
test('server configuration only accepts an HTTPS origin; HTTP is local development only',()=>{
  assert.equal(serverOrigin(' https://staff.gkucconstruction.com/ '),'https://staff.gkucconstruction.com');
  for(const value of ['http://example.com','https://user:password@example.com','https://example.com/api','https://example.com?token=secret','file:///tmp/a'])assert.throws(()=>serverOrigin(value));
  assert.equal(serverOrigin('http://127.0.0.1:43973',true),'http://127.0.0.1:43973');
  assert.throws(()=>serverOrigin('http://example.com',true));
});
test('API, document and share paths use the selected server, assets stay local',()=>{
  for(const pathname of ['/api/events','/uploads/a.pdf','/s/example'])assert.equal(requestTarget('siteops://app'+pathname,'https://example.com').remote,'https://example.com'+pathname);
  assert.deepEqual(requestTarget('siteops://app/assets/a.js','https://example.com'),{file:'assets/a.js'});
  assert.throws(()=>requestTarget('siteops://other/api/events','https://example.com'));
  assert.throws(()=>requestTarget('siteops://app/%2e%2e%2fprivate','https://example.com'));
  assert.throws(()=>assetPath('/tmp/ui','../secret'));
});
test('navigation rejects executable URLs and untrusted native destinations',()=>{
  assert.equal(navigationAllowed('about:blank','https://example.com'),true);
  assert.equal(navigationAllowed('blob:siteops://app/example','https://example.com'),true);
  for(const url of ['javascript:alert(1)','file:///etc/passwd','https://evil.example','siteops://evil/'])assert.equal(navigationAllowed(url,'https://example.com'),false);
  assert.equal(externalAllowed('https://example.com'),true);
  assert.equal(externalAllowed('file:///tmp/a'),false);
});
