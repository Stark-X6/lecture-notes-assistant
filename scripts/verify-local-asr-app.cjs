const {fakeMicrophonePermission}=require("../tests/helpers/macos-permission.cjs");
const {_electron}=require('@playwright/test');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const qa=process.env.LECTURE_TEST_MODEL_ROOT || path.resolve('.test-data','local-asr-models'), data=path.resolve('.test-data','asr-integrated-'+Date.now());
 const sample=path.join(qa,'sensevoice-small-int8','test_wavs','zh.wav');
 const executablePath=process.env.LECTURE_EXECUTABLE;
 const app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:['.']),'--no-sandbox','--user-data-dir='+path.join(data,'runtime'),'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+sample],env:{...process.env,LECTURE_DATA_DIR:data,LECTURE_MODEL_DIR:qa},timeout:30000});
 const electronPid=await app.evaluate(()=>process.pid);
 const warnings=[];
 try{
  await fakeMicrophonePermission(app);
  const page=await app.firstWindow(); await page.waitForFunction(()=>!!window.desktop);
  const invoke=(method,args={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  await page.evaluate(()=>window.desktop.subscribe(e=>{if(e.type==='warning')console.warn(e.message)}));
  page.on('console',m=>{if(m.type()==='warning')warnings.push(m.text())});
  const initial=await invoke('snapshot');assert.equal(initial.config.asrBackend,'local');assert.equal(initial.config.mode,'off');assert.equal(initial.localAsr.ready,true);
  const test=await invoke('localAsr.test');assert.match(test.text,/开放时间|开饭时间/);console.log('native model in Electron:',JSON.stringify(test));
  const course=await invoke('course.create',{name:'本地 ASR 验证'});
  const lesson=await invoke('lesson.create',{courseId:course.id,name:'导入语音验证'});
  const wave=require('sherpa-onnx-node').readWave(sample), length=Math.round(wave.samples.length*24000/wave.sampleRate),pcm=Buffer.alloc(length*2);
  for(let i=0;i<length;i++){const x=i*wave.sampleRate/24000,j=Math.floor(x),v=wave.samples[j]*(1-(x-j))+(wave.samples[Math.min(j+1,wave.samples.length-1)]||0)*(x-j);pcm.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*32767))),i*2)}
  await invoke('audio.store',{lessonId:lesson.id,pcm:[...pcm]});await invoke('audio.backfill',{lessonId:lesson.id});
  const after=await invoke('snapshot'), utterances=after.utterances.filter(u=>u.lessonId===lesson.id);
  assert.ok(utterances.length);assert.ok(after.chunks.filter(c=>c.lessonId===lesson.id).every(c=>c.transcribed));assert.equal(after.lessons.find(l=>l.id===lesson.id).calls,0);assert.equal(after.tasks.length,0);assert.equal(after.courses[0].consent.audio,false);
  const duplicate=await invoke('audio.backfill',{lessonId:lesson.id});assert.equal(duplicate.count,0);assert.equal((await invoke('snapshot')).utterances.length,utterances.length);
  console.log('import + text AI off + no API/consent + duplicate prevention:',utterances.map(u=>u.text));
  const recorded=await invoke('lesson.create',{courseId:course.id,name:'录音语音验证'});
  await invoke('recording.start',{lessonId:recorded.id});await page.waitForTimeout(6400);await invoke('recording.stop');await invoke('audio.backfill',{lessonId:recorded.id});
  const result=await invoke('snapshot'), chunks=result.chunks.filter(c=>c.lessonId===recorded.id),texts=result.utterances.filter(u=>u.lessonId===recorded.id);
  assert.ok(chunks.length>=2);assert.ok(chunks.every(c=>c.transcribed));assert.ok(texts.length);assert.equal(result.lessons.find(l=>l.id===recorded.id).recording,'stopped');
  console.log('recording + 5s segmentation + stop tail:',{chunks:chunks.length,durationMs:chunks.at(-1).endMs,text:texts.map(u=>u.text)});
  await page.getByRole('button',{name:'本地 ASR 验证',exact:true}).click();
  await page.getByText('API 与设置',{exact:true}).click();await page.getByRole('button',{name:'测试本地模型',exact:true}).click();await page.locator('.local-asr-test-result').waitFor();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/local-asr-settings.png'});
  console.log('settings screenshot: artifacts/local-asr-settings.png; warnings:',warnings);
 }finally{try{process.kill(electronPid)}catch{} app.process().kill();}
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
