import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const env=process.env;
const port=Number(env.PORT||3000),rtpPort=Number(env.RTP_PORT||40000);
const ariUrl=(env.ARI_URL||'').replace(/\/$/,'');
const app='freepbxselect';
const config=JSON.parse(env.CONTACTS_JSON || fs.readFileSync('/app/config.json','utf8'));
if(!config.contacts?.length)throw Error('config.json needs contacts');
if(!ariUrl||!env.ARI_USER||!env.ARI_PASSWORD||!env.RTP_HOST)throw Error('Set ARI_URL, ARI_USER, ARI_PASSWORD, and RTP_HOST');
for(const c of config.contacts)if(!c.name||!/^[0-9*#+-]+$/.test(c.extension))throw Error('Invalid contact');
if(!/^[a-zA-Z0-9_-]+$/.test(config.dialContext||'from-internal'))throw Error('Invalid dialContext');
const basic=Buffer.from(env.ARI_USER+':'+env.ARI_PASSWORD).toString('base64');
let index=0,phase='idle',intercom=null,contactChannel=null,mediaChannel=null,bridge=null,session=0,remote=null;
let audioJob=null,audioToken=0,ws=null,ready=false,incoming=null,reconnectTimer=null;
const clients=new Set();const rtp=dgram.createSocket('udp4');let seq=0,timestamp=0,ssrc=Math.floor(Math.random()*0xffffffff);
function state(){return {name:config.contacts[index].name,index,phase,connected:ready,contacts:config.contacts.length}}
function notify(){const data='data: '+JSON.stringify(state())+'\n\n';for(const res of clients)res.write(data)}
function setPhase(p){phase=p;notify()}
async function ari(method,path,body){const res=await fetch(ariUrl+path,{method,headers:{Authorization:'Basic '+basic,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!res.ok)throw Error('ARI '+method+' '+path+' '+res.status+' '+(await res.text()).slice(0,200));const raw=await res.text();return raw?JSON.parse(raw):null}
const q=x=>encodeURIComponent(x);
// Synthesize phrases once. Cached G.711 audio makes contact navigation immediate
// and prevents slow Piper model startup from delaying every button press.
const speechCache=new Map();
let playTimer=null,playToken=0,pendingSpeech=null,playResolve=null;
function stopAudio(){playToken++;if(playTimer)clearTimeout(playTimer);playTimer=null;pendingSpeech=null;if(playResolve){playResolve();playResolve=null}}
function synthesize(text){
 if(speechCache.has(text))return speechCache.get(text);
 const promise=new Promise((resolve,reject)=>{
  const synth=spawn('/opt/piper/bin/piper',['--model',env.PIPER_MODEL||'/opt/voices/en_US-lessac-medium.onnx','--output-raw'],{stdio:['pipe','pipe','pipe']});
  const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-f','s16le','-ar',env.PIPER_SAMPLE_RATE||'22050','-ac','1','-i','pipe:0','-f','mulaw','-ar','8000','-ac','1','pipe:1'],{stdio:['pipe','pipe','pipe']});
  const data=[];let completed=false;let stderr='';
  const timer=setTimeout(()=>finish(new Error('Speech synthesis timed out')),30000);
  function finish(err,buffer){if(completed)return;completed=true;clearTimeout(timer);if(err){synth.kill();ff.kill();reject(err)}else resolve(buffer)}
  synth.on('error',e=>finish(e));ff.on('error',e=>finish(e));
  synth.stderr.on('data',x=>{stderr+=x.toString().slice(0,1000)});
  ff.stderr.on('data',x=>{stderr+=x.toString().slice(0,1000)});
  synth.stdout.pipe(ff.stdin);
  synth.stdin.end(text+'\n');
  ff.stdout.on('data',x=>data.push(x));
  ff.on('close',code=>{if(code!==0)return finish(new Error('Piper/FFmpeg failed: '+stderr));const output=Buffer.concat(data);if(!output.length)return finish(new Error('Piper generated empty audio'));finish(null,output)});
 });
 speechCache.set(text,promise);
 promise.catch(e=>{if(speechCache.get(text)===promise)speechCache.delete(text);console.error('TTS:',text,e.message)});
 return promise;
}
function preloadSpeech(){
 // Serial warming avoids launching too many expensive inference jobs at once.
 const phrases=[...config.contacts.map(x=>x.name),...config.contacts.map(x=>'Calling '+x.name),'Call ended','Call failed'];
 (async()=>{for(const phrase of new Set(phrases))try{await synthesize(phrase)}catch{}})();
}
function sendPacket(audio,offset){
 if(!remote)return;
 const packet=Buffer.alloc(172,0xff);packet[0]=0x80;packet[1]=0;
 packet.writeUInt16BE(seq++&65535,2);packet.writeUInt32BE(timestamp>>>0,4);
 packet.writeUInt32BE(ssrc>>>0,8);timestamp=(timestamp+160)>>>0;
 if(offset>=0)audio.copy(packet,12,offset,Math.min(offset+160,audio.length));
 rtp.send(packet,remote.port,remote.address);
}
async function say(text){
 stopAudio();
 const token=playToken;
 try{
  const audio=await synthesize(text);
  if(token!==playToken)return;
  if(!remote){pendingSpeech=text;return}
  // Packet pacing with initial silence, and enough tail to finish the final phoneme.
  await new Promise(resolve=>{
   playResolve=resolve;
   let step=0;
   const lead=2,frames=Math.ceil(audio.length/160),tail=3;
   const start=Date.now();
   function tick(){
    if(token!==playToken||!remote){if(playResolve===resolve)playResolve=null;resolve();return}
    const offset=step<lead||step>=lead+frames?-1:(step-lead)*160;
    sendPacket(audio,offset);step++;
    if(step<lead+frames+tail)playTimer=setTimeout(tick,Math.max(1,start+step*20-Date.now()));
    else{playTimer=null;if(playResolve===resolve)playResolve=null;resolve()}
   }
   tick();
  });
 }catch(e){console.error('Cannot announce',text,e.message)}
}
// Locally generated North American ringback cadence (440 + 480 Hz; 2s on, 4s off).
// This is only audible in the menu bridge, not sent to the remote phone.
function ulaw(sample){
 let pcm=Math.max(-32635,Math.min(32635,Math.round(sample)));
 const sign=pcm<0?0x80:0;
 pcm=Math.abs(pcm)+132;
 let exponent=7;
 for(let mask=0x4000;exponent>0&&!(pcm&mask);mask>>=1)exponent--;
 const mantissa=(pcm>>(exponent+3))&15;
 return (~(sign|(exponent<<4)|mantissa))&255;
}
const ringFrame=Buffer.alloc(160);
for(let i=0;i<160;i++){
 const t=i/8000;
 ringFrame[i]=ulaw(2600*(Math.sin(2*Math.PI*440*t)+Math.sin(2*Math.PI*480*t)));
}
function startRingback(stamp){
 stopAudio();
 const token=playToken,started=Date.now();
 let step=0;
 function tick(){
  if(token!==playToken||session!==stamp||phase!=='dialing'||!remote)return;
  const on=(step%300)<100;
  sendPacket(on?ringFrame:Buffer.alloc(0),on?0:-1);
  step++;
  playTimer=setTimeout(tick,Math.max(1,started+step*20-Date.now()));
 }
 tick();
}
function scheduleReconnect(){if(reconnectTimer)clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{reconnectTimer=null;if(ready&&phase==='idle')begin().catch(console.error)},2000)}
function clearSession(){stopAudio();remote=null;intercom=null;contactChannel=null;mediaChannel=null;bridge=null;incoming=null;session++;setPhase('idle')}
async function hang(){const ids=[contactChannel,incoming,intercom,mediaChannel].filter(Boolean);const b=bridge;clearSession();await Promise.allSettled([...ids.map(id=>ari('DELETE','/channels/'+q(id))),...(b?[ari('DELETE','/bridges/'+q(b))]:[])])}
async function begin(){
 if(phase!=='idle'||!ready)return;
 const stamp=++session,endpoint=env.INTERCOM_ENDPOINT||'PJSIP/777';
 setPhase('calling-intercom');
 try{
  const id=randomUUID();intercom=id;
  console.log('Originating intercom:',endpoint,'channel:',id);
  await ari('POST','/channels?'+new URLSearchParams({endpoint,app,appArgs:'intercom',channelId:id,timeout:'15',callerId:env.INTERCOM_CALLER_ID||'FreePBX Select <7000>'}),{variables:{'PJSIP_HEADER(add,Call-Info)':'<sip:freepbxselect@localhost>;answer-after=0','PJSIP_HEADER(add,Alert-Info)':'<http://www.notused.com>;info=alert-autoanswer'}});
  if(stamp!==session)return;
 }catch(e){console.error('Intercom originate failed for',endpoint,e);if(stamp===session){await hang();scheduleReconnect()}}
}
async function enterMenu(){if(phase!=='calling-intercom'||!intercom)return;const stamp=session;
 try{bridge=randomUUID();await ari('POST','/bridges/'+q(bridge)+'?type=mixing');await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(intercom));
 mediaChannel=randomUUID();await ari('POST','/channels/externalMedia?'+new URLSearchParams({app,external_host:env.RTP_HOST+':'+rtpPort,format:'ulaw',channelId:mediaChannel,encapsulation:'rtp',transport:'udp',direction:'both'}));
 if(stamp!==session)return;await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(mediaChannel));setPhase('menu');say(config.contacts[index].name)
 }catch(e){console.error('Menu setup failed',e);if(stamp===session){await hang();scheduleReconnect()}}}
async function returnToMenu(feedback=''){
 if(!bridge||!mediaChannel||!intercom)return;
 const old=contactChannel;contactChannel=null;incoming=null;stopAudio();
 if(old)await ari('DELETE','/channels/'+q(old)).catch(()=>{});
 await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(mediaChannel)).catch(console.error);
 setPhase('menu');say(feedback||config.contacts[index].name);
}
async function choose(){
 if(phase==='idle')return begin();
 if(phase==='menu'){
  stopAudio();const stamp=session;const selected=config.contacts[index];setPhase('dialing');
  // Speak the selected name immediately, then use ringback until the call connects.
  void (async()=>{
   await say('Calling '+selected.name);
   if(stamp!==session||phase!=='dialing')return;
   try{
    const id=randomUUID();contactChannel=id;
    await ari('POST','/channels?'+new URLSearchParams({endpoint:'Local/'+selected.extension+'@'+(config.dialContext||'from-internal'),app,appArgs:'destination',channelId:id,timeout:'45'}));
    if(stamp===session&&phase==='dialing')startRingback(stamp);
   }catch(e){console.error('Dial failed',e);if(stamp===session&&phase==='dialing')await returnToMenu('Call failed')}
  })();
  return;
 }
 if(phase==='dialing'||phase==='connected'){
  const id=incoming||contactChannel;incoming=null;contactChannel=null;stopAudio();
  if(id)await ari('DELETE','/channels/'+q(id)).catch(console.error);
  await returnToMenu();return;
 }
}
async function navigation(direction){
 // Selection belongs to the controller, not the SIP call. Never freeze the UI
 // because an endpoint is ringing, busy, unavailable, or reconnecting.
 if(phase==='dialing'||phase==='connected'||phase==='incoming')return;
 index=(index+direction+config.contacts.length)%config.contacts.length;
 notify();
 if(phase==='menu')say(config.contacts[index].name);
}
async function handleIncoming(id){
 if(!bridge||!intercom||!mediaChannel||incoming||phase==='connected'||phase==='dialing'){
  // Return to the dialplan fallback instead of leaving the caller stuck.
  await ari('POST','/channels/'+q(id)+'/continue?context=freepbxselect-fallback&extension=s&priority=1').catch(console.error);
  return;
 }
 incoming=id;stopAudio();setPhase('incoming');
 try{
  await ari('POST','/channels/'+q(id)+'/answer');
  await ari('POST','/bridges/'+q(bridge)+'/removeChannel?channel='+q(mediaChannel)).catch(()=>{});
  await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(id));
  setPhase('connected');
 }catch(e){
  console.error('Incoming bridge failed',e);incoming=null;
  await ari('POST','/channels/'+q(id)+'/continue?context=freepbxselect-fallback&extension=s&priority=1').catch(console.error);
  await returnToMenu();
 }
}
async function onEvent(ev){
 const id=ev.channel?.id;
 if(id===intercom&&(ev.type==='ChannelStateChange'||ev.type==='ChannelDestroyed'||ev.type==='StasisStart'||ev.type==='StasisEnd'))
  console.log('Intercom event:',ev.type,'state:',ev.channel?.state,'cause:',ev.cause,'cause_txt:',ev.cause_txt,'channel:',id);
 if(ev.type==='StasisStart'){
  if(ev.args?.[0]==='incoming'){await handleIncoming(id);return}
  if(id===intercom){await enterMenu();return}
  if(id===contactChannel&&bridge&&phase==='dialing'){
   await ari('POST','/bridges/'+q(bridge)+'/addChannel?channel='+q(id));
   stopAudio();await ari('POST','/bridges/'+q(bridge)+'/removeChannel?channel='+q(mediaChannel)).catch(()=>{});setPhase('connected');
  }
 }else if(ev.type==='StasisEnd'||ev.type==='ChannelDestroyed'){
  if(id===intercom){await hang();scheduleReconnect()}
  else if(id===incoming){incoming=null;await returnToMenu('Call ended')}
  else if(id===contactChannel){contactChannel=null;if(phase==='connected'||phase==='dialing')await returnToMenu('Call ended')}
  else if(id===mediaChannel&&phase!=='idle'){await hang();scheduleReconnect()}
 }
}
function connect(){const u=new URL(ariUrl);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname=u.pathname.replace(/\/$/,'')+'/events';u.search=new URLSearchParams({app,api_key:env.ARI_USER+':'+env.ARI_PASSWORD}).toString();ws=new WebSocket(u);ws.on('open',()=>{ready=true;notify();scheduleReconnect()});ws.on('message',raw=>{try{onEvent(JSON.parse(raw.toString())).catch(console.error)}catch(e){console.error(e)}});ws.on('close',()=>{ready=false;notify();if(phase!=='idle')hang().catch(console.error);setTimeout(connect,3000)});ws.on('error',e=>console.error('ARI websocket',e.message))}
rtp.on('message',(_,rinfo)=>{if(mediaChannel&&!remote){remote={address:rinfo.address,port:rinfo.port};if(pendingSpeech){const name=pendingSpeech;pendingSpeech=null;say(name)}}});rtp.bind(rtpPort);
preloadSpeech();
const html=fs.readFileSync(new URL('./public/index.html',import.meta.url));
let queue=Promise.resolve();
const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');const send=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(obj))};
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return}
 if(url.pathname==='/health'){send(200,{ok:true,ari:ready});return}
 if(req.method==='GET'&&url.pathname==='/api/state'){send(200,state());return}
 if(req.method==='GET'&&url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: '+JSON.stringify(state())+'\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return}
 if(req.method==='POST'&&['/api/left','/api/right','/api/select'].includes(url.pathname)){queue=queue.catch(console.error).then(()=>url.pathname==='/api/left'?navigation(-1):url.pathname==='/api/right'?navigation(1):choose());queue.then(()=>send(200,state()),e=>{console.error(e);send(500,{error:'Operation failed'})});return}
 send(404,{error:'Not found'});
});
server.listen(port,()=>console.log('FreePBX Select listening on',port));connect();
