const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = path.resolve(__dirname, "../../.."), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "biodesign-voice-ui-"));
app.setPath("userData", path.join(temporary, "profile"));
app.commandLine.appendSwitch("disable-background-networking");
(async () => {
  try {
    await app.whenReady();
    const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    fs.writeFileSync(path.join(temporary, "fixture.html"), '<!doctype html><html><body><form id="form"><textarea id="input">Existing draft</textarea><button type="button" id="voice">Voice</button><button>Send</button></form></body></html>');
    await win.loadFile(path.join(temporary, "fixture.html"));
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, "docs/voice-composer.js"), "utf8"));
    const passed = await win.webContents.executeJavaScript(`(async()=>{
      let passed=0,sends=0,inputs=0,stops=0,time=0,pending,resolve,canStart=false,deviceRequests=0;const tick=()=>new Promise(done=>setTimeout(done,20)),check=(value,label)=>{if(!value)throw Error(label);passed++;};
      const input=document.getElementById('input'),button=document.getElementById('voice');document.getElementById('form').addEventListener('submit',event=>{event.preventDefault();sends++;});input.addEventListener('input',()=>inputs++);
      class Recorder{static isTypeSupported(type){return type==='audio/webm';}constructor(){this.mimeType='audio/webm';this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['recorded data'])});void this.onstop();}}
      const controller=window.BioDesignVoiceComposer.attach(input,{button,Recorder,canStart:()=>canStart,now:()=>time,mediaDevices:{getUserMedia:async()=>{deviceRequests++;return{getTracks:()=>[{stop(){stops++;}}]};}},transcribe:async()=>{if(pending)return new Promise(done=>resolve=done);return{text:'new transcript'};},onError:error=>{throw error;}});
      button.click();await tick();check(deviceRequests===0,'startup guard prevents microphone permission');canStart=true;input.disabled=true;button.click();await tick();check(deviceRequests===0,'disabled composer cannot request device');input.disabled=false;
      button.click();await tick();check(button.dataset.voiceState==='recording','record state visible');time=1000;canStart=false;button.click();await tick();check(deviceRequests===1,'active recording can stop after startup becomes unavailable');canStart=true;
      check(input.value==='Existing draft new transcript','transcript appended to editable draft');check(inputs===1&&sends===0,'input event emitted without submit');check(stops===1&&button.dataset.voiceState==='idle','tracks released and idle restored');
      pending=true;button.click();await tick();time=2000;button.click();await tick();check(button.disabled&&button.dataset.voiceState==='transcribing','pending transcription visible');
      input.remove();await tick();resolve({text:'wrong conversation'});await tick();check(!input.value.includes('wrong conversation'),'detached input ignores delayed result');check(controller.state==='idle','detached composer cancelled');controller.destroy();check(button.textContent==='Voice','destroy restores button');return passed;
    })()`);
    console.log(`VOICE_COMPOSER_RESULT ${JSON.stringify({ passed })}`); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
  finally { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} }
})();
