import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const env=process.env;
const port=Number(env.PORT||3000),rtpPort=Number(env.RTP_PORT||40000);
const ariUrl=(env.ARI_URL||'').replace(/\/$/,'');
const app='freepbxselect';
const config=JSON.parse(env.CONTACTS_JSON || fs.readFileSync('/app/config.json','utf8'));
if(!config.contacts?.length)throw Error('config.json needs contacts');
if(!ariUrl||!env.ARI_USER||!env.ARI_PASSWORD||!env.API_KEY||!env.RTP_HOST)throw Error('Set ARI_URL, ARI_USER, ARI_PASSWORD, API_KEY and RTP_HOST');
for(const c of config.contacts)if(!c.name||!/^[0-9*#+-]+$/.test(c.extension))throw Error('Invalid contact');
if(!/^[a-zA-Z0-9_-]+$/.test(config.dialContext||'from-internal'))throw Error('Invalid dialContext');
const basic=Buffer.from(env.ARI_USER+':'+env.ARI_PASSWORD).toString('base64');
let index=0,phase='idle',intercom=null,contactChannel=null,mediaChannel=null,bridge=null,session=0,remote=null;
let audioJob=null,audioToken=0,ws=null,ready=false;
const clients=new Set();const rtp=dgram.createSocket('udp4');let seq=0,timestamp=0,ssrc=Math.floor(Math.random()*0xffffffff);
function state(){return {name:config.contacts[index].name,index,phase,connected:ready,contacts:config.contacts.length}}
function notify(){const data='data: '+JSON.stringify(state())+'\n\n';for(const res of clients)res.write(data)}
function setPhase(p){phase=p;notify()}
async function ari(method,path,body){const res=await fetch(ariUrl+path,{method,headers:{Authorization:'Basic '+basic,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!res.ok)throw Error('ARI '+method+' '+path+' '+res.status+' '+(await res.text()).slice(0,200));const raw=await res.text();return raw?JSON.parse(raw):null}
const q=x=>encodeURIComponent(x);
function stopAudio(){audioToken++;if(audioJob){audioJob.kill();audioJob=null}}
function say(text){stopAudio();if(!remote)return;const token=audioToken;
 // ffmpeg converts synthesised WAV to 8kHz, G.711 mu-law RTP payload.
 const synth=spawn('espeak-ng',['--stdout','-s','155',text],{stdio:['ignore','pipe','ignore']});
 const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-f','mulaw','-ar','8000','-ac','1','pipe:1'],{stdio:['pipe','pipe','ignore']});
 audioJob=ff;synth.stdout.pipe(ff.stdin);let chunks=[],offset=0,ended=false;
 ff.stdout.on('data',x=>chunks.push(x));
 ff.on('close',()=>{ended=true;if(audioJob===ff)audioJob=null});
 let next=Date.now();
 const tick=()=>{if(token!==audioToken)return;const buf=Buffer.concat(chunks);if(buf.length-offset>=160){const pkt=Buffer.alloc(172);pkt[0]=0x80;pkt[1]=0;pkt.writeUInt16BE(seq++&65535,2);pkt.writeUInt32BE(timestamp>>>0,4);pkt.writeUInt32BE(ssrc>>>0,8);buf.copy(pkt,12,offset,offset+160);offset+=160;timestamp+=160;rtp.send(pkt,remote.port,remote.address)}
 if(ended&&buf.length-offset<160)return;
 next+=20;setTimeout(tick,Math.max(0,next-Date.now()))};tick();
}
function clearSession(){stopAudio();remote=null;intercom=null;contactChannel=null;mediaChannel=null;bridge=null;session++;setPhase('idle')}
async function hang(){const ids=[contactChannel,intercom,mediaChannel].filter(Boolean);const b=bridge;clearSession();await Promise.allSettled([...ids.map(id=>ari('DELETE','/channels/'+q(id))),...(b?[ari('DELETE','/bridges/'+q(b))]:[])])}
async function begin(){if(phase!=='idle')return;const stamp=++session;setPhase('calling-intercom');try{const id=randomUUID();intercom=id;await ari('POST','/channels?'+new URLSearchParams({endpoint:env.INTERCOM_ENDPOINT||'PJSIP/777',app,appArgs:'intercom',channelId:id,timeout:'15'}));if(stamp!==session)return}catch(e){console.error('Call failed',e);if(stamp===session)await hang()}}
async function enterMenu(){if(phase!=='calling-intercom'||!intercom)return;const stamp=session;
 try{bridge=randomUUID();await ari('POST','/bridges/'+q(bridge)+'?type=mixing');await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(intercom));
 mediaChannel=randomUUID();await ari('POST','/channels/externalMedia?'+new URLSearchParams({app,external_host:env.RTP_HOST+':'+rtpPort,format:'ulaw',channelId:mediaChannel,encapsulation:'rtp',transport:'udp',direction:'both'}));
 if(stamp!==session)return;await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(mediaChannel));setPhase('menu');say(config.contacts[index].name)
 }catch(e){console.error('Menu setup failed',e);if(stamp===session)await hang()}}
async function choose(){if(phase==='idle')return begin();if(phase==='menu'){stopAudio();const stamp=session;setPhase('dialing');try{const id=randomUUID();contactChannel=id;await ari('POST','/channels?'+new URLSearchParams({endpoint:'Local/'+config.contacts[index].extension+'@'+(config.dialContext||'from-internal'),app,appArgs:'destination',channelId:id,timeout:'45'}));}catch(e){console.error('Dial failed',e);if(stamp===session){contactChannel=null;setPhase('menu');say('Call failed')}}return}return hang()}
async function navigation(direction){if(phase==='idle'){index=(index+direction+config.contacts.length)%config.contacts.length;notify();await begin();return}if(phase!=='menu')return;index=(index+direction+config.contacts.length)%config.contacts.length;notify();say(config.contacts[index].name)}
async function onEvent(ev){if(ev.type==='StasisStart'){const id=ev.channel?.id;if(id===intercom)await enterMenu();else if(id===contactChannel&&bridge&&phase==='dialing'){await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(id));setPhase('connected')}}else if(ev.type==='StasisEnd'||ev.type==='ChannelDestroyed'){const id=ev.channel?.id;if(id===intercom){await hang()}else if(id===contactChannel){contactChannel=null;if(phase==='connected'||phase==='dialing'){setPhase('menu');say(config.contacts[index].name)}}else if(id===mediaChannel&&phase!=='idle'){await hang()}}}
function connect(){const u=new URL(ariUrl);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname=u.pathname.replace(/\/$/,'')+'/events';u.search=new URLSearchParams({app,api_key:env.ARI_USER+':'+env.ARI_PASSWORD}).toString();ws=new WebSocket(u);ws.on('open',()=>{ready=true;notify()});ws.on('message',raw=>{try{onEvent(JSON.parse(raw.toString())).catch(console.error)}catch(e){console.error(e)}});ws.on('close',()=>{ready=false;notify();if(phase!=='idle')hang().catch(console.error);setTimeout(connect,3000)});ws.on('error',e=>console.error('ARI websocket',e.message))}
rtp.on('message',(_,rinfo)=>{if(mediaChannel&&!remote)remote={address:rinfo.address,port:rinfo.port}});rtp.bind(rtpPort);
function authorized(req){const key=req.headers['x-api-key']||new URL(req.url,'http://localhost').searchParams.get('key')||'';const a=Buffer.from(String(key)),b=Buffer.from(env.API_KEY);return a.length===b.length&&timingSafeEqual(a,b)}
const html=fs.readFileSync(new URL('./public/index.html',import.meta.url));
let queue=Promise.resolve();
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
 if(url.pathname==='/health'){send(200,{ok:true,ari:ready});return}
 if(url.pathname.startsWith('/api/')&&!authorized(req)){send(401,{error:'Unauthorized'});return}
 if(req.method==='GET'&&url.pathname==='/api/state'){send(200,state());return}
 if(req.method==='GET'&&url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: '+JSON.stringify(state())+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
 if(req.method==='POST'&&['/api/left','/api/right','/api/select'].includes(url.pathname)){queue=queue.catch(console.error).then(()=>url.pathname==='/api/left'?navigation(-1):url.pathname==='/api/right'?navigation(1):choose());queue.then(()=>send(200,state()),e=>{console.error(e);send(500,{error:'Operation failed'})});return}
 send(404,{error:'Not found'});
});
server.listen(port,()=>console.log('FreePBX Select listening on',port));connect();
