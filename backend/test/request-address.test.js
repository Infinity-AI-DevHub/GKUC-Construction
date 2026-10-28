import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {captureRequestAddress} from '../src/lib/request-address.js';
function request(trust=false,forwarded='198.51.100.25'){
  const app=express();app.set('trust proxy',trust);
  const req=Object.create(express.request);
  req.app=app;req.headers={'x-forwarded-for':forwarded};req.socket={remoteAddress:'127.0.0.1'};
  return req;
}
test('upload audit IP survives a detached request socket',()=>{
  const req=request();let continued=false;
  captureRequestAddress(req,{},()=>{continued=true;});req.socket=null;
  assert.equal(req.ip,'127.0.0.1');assert.equal(continued,true);
});
test('captured address respects configured trusted proxies',()=>{
  const req=request('loopback');captureRequestAddress(req,{},()=>{});req.socket=null;
  assert.equal(req.ip,'198.51.100.25');
});
test('untrusted forwarded headers cannot replace the peer address',()=>{
  const req=request(false,'203.0.113.99');captureRequestAddress(req,{},()=>{});
  req.headers['x-forwarded-for']='192.0.2.77';req.socket=null;
  assert.equal(req.ip,'127.0.0.1');
});
