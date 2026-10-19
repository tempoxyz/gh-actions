// Deterministic clock/issuer fixture; no real credentials or STS calls.
const path = require('node:path');
const { createSocketLease } = require('../socket-lease.cjs');
const { createTokenServer } = require(process.env.SOCKET_PROVIDER_MODULE || path.join(__dirname, '..', 'token-server.cjs'));
const readline = require('node:readline');
const INITIAL = 'socket-fixture-initial-' + 'a'.repeat(32);
const NEXT = 'socket-fixture-replacement-' + 'b'.repeat(32);
let time = 1800000000000, scheduled;
const lease = createSocketLease({token:INITIAL, expiresAt:new Date(time+3600000).toISOString(),endpoint:'socket-sts.tempoxyz.net'}, {
 now:()=>time,
 setTimer(fn,delay){ scheduled={fn,at:time+delay}; return {unref(){}}; },
 clearTimer(){},
 exchange:async()=>({token:NEXT,expiresAt:new Date(time+3600000).toISOString()}),
 revoke:async()=>{},
});
const {server,route}=createTokenServer(INITIAL,async()=>'',lease);
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}${route}`})));
readline.createInterface({input:process.stdin}).on('line',async line=>{
 if(line==='renew'){time=scheduled.at;await scheduled.fn();console.log(JSON.stringify({renewed:true}));}
});
