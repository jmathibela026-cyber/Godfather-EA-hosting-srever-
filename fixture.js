const { analyze } = require('./strategy');
const T0 = Date.UTC(2026,0,1), H4=4*3600e3, M15=15*60e3, mk=(t,o,h,l,c)=>({t,o,h,l,c});
const htf=[]; for(let i=0;i<39;i++){const b=104+Math.sin(i)*1.5; htf.push(mk(T0+i*H4,b,b+.6,b-.6,b+.1));}
htf[30]=mk(T0+30*H4,107,110,106.5,107.5); for(let i=31;i<39;i++){const b=104+(i-30)*0.4;htf[i]=mk(T0+i*H4,b,b+.5,b-.5,b+.1)}
htf.push(mk(T0+39*H4,107.5,111,107,108.5));              // sweep: wick 111 > 110, closes back below
const sweepT=T0+39*H4;
const cl=[109.2,109.0,108.8,108.5,108.8,109.3,109.8,110.2,109.9,109.5,109.0,108.6,108.2,108.0,108.1,107.9,108.3,108.7,109.0];
let prev=109.3; const ltf=cl.map((c,i)=>{const o=prev;prev=c;return mk(sweepT+i*M15,o,Math.max(o,c)+.1+((i*7)%5)*.03,Math.min(o,c)-.1-((i*11)%5)*.03,c)});
module.exports={htf,ltf};
