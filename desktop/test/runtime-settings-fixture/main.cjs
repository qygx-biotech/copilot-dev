const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "../../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "biodesign-runtime-settings-ui-"));
app.setPath("userData", path.join(temporary, "profile"));
app.commandLine.appendSwitch("disable-background-networking");
(async () => {
  try {
    await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RuntimeExtensions} from './desktop/renderer/components/RuntimeExtensions.jsx'; createRoot(document.getElementById('root')).render(<RuntimeExtensions close={()=>window.closedSettings=true}/>);`, resolveDir: root, loader: "jsx" }, bundle: true, outfile: path.join(temporary, "fixture.js"), logLevel: "silent" });
    const html = `<!doctype html><html><head><link rel="stylesheet" href="fixture.css"/></head><body><div id="root"></div><script>
      window.calls=[]; window.preset=null; window.addEventListener('biodesign:model-preset',event=>window.preset=event.detail);
      window.skill={name:'evidence-review',description:'Review source citations',path:'.biodesign/skills/evidence-review/SKILL.md',source:'project',enabled:true,available:true,removable:true};
      window.profiles=[]; window.biodesignDesktop={execution:{runWorkflow:async ({workflowId,input})=>{
        window.calls.push({workflowId,input});
        if(workflowId==='runtime_skills_list')return {skills:window.skill?[window.skill]:[],errors:[]};
        if(workflowId==='runtime_skills_remove'){window.skill=null;return {};}
        if(workflowId==='runtime_mcp_list')return {servers:[]};
        if(workflowId==='runtime_apps_list')return {apps:[{id:'builtin-paper',kind:'integrated',name:'Paper research',description:'Integrated literature tools',status:'integrated',enabled:true}],presets:[{id:'local',name:'Local MCP program',description:'Use an installed program',config:{transport:'stdio',command:'',args:[],enabled:false,enabledTools:[]}}]};
        if(workflowId==='runtime_apps_inspect')return {id:'review',name:'Review bundle',path:input.path,digest:'pinned-digest',description:'Local skill bundle',skills:[{name:'review',description:'Review evidence'}],servers:[],conflicts:[]};
        if(workflowId==='runtime_apps_install')return {};
        if(workflowId==='runtime_settings_read')return {presets:window.profiles};
        if(workflowId==='runtime_settings_save'){window.profiles.push(input);return {presets:window.profiles};}
        throw new Error('Unexpected workflow '+workflowId);
      }}};
    </script><script src="fixture.js"></script></body></html>`;
    fs.writeFileSync(path.join(temporary, "fixture.html"), html);
    await app.whenReady();
    const win = new BrowserWindow({ width: 1200, height: 1000, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
    await win.loadFile(path.join(temporary, "fixture.html"));
    const passed = await win.webContents.executeJavaScript(`(async()=>{
      let passed=0;const tick=()=>new Promise(resolve=>setTimeout(resolve,60));const check=(value,label)=>{if(!value)throw new Error(label);passed++;};
      const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent===text);
      const fill=(input,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
      await tick();check(document.querySelector('dialog').open,'modal opened');
      check(document.querySelectorAll('.runtime-item').length===1,'skill listed');
      fill(document.querySelector('[aria-label="Search skills"]'),'missing');await tick();check(document.body.textContent.includes('No matching skills'),'search filters skills');
      fill(document.querySelector('[aria-label="Search skills"]'),'evidence');await tick();button('Remove').click();await tick();button('Confirm removal').click();await tick();check(window.calls.some(call=>call.workflowId==='runtime_skills_remove'&&call.input.name==='evidence-review'),'remove reaches scoped workflow');
      button('Apps').click();await tick();check(document.body.textContent.includes('Paper research'),'integrated Apps remain');
      button('Configure').click();await tick();check(document.querySelector('input[pattern="[a-z][a-z0-9_-]*"]').disabled===false,'MCP template allows a new name');
      check(!document.querySelector('.runtime-toggle input').checked,'template disabled by default');
      button('Apps').click();await tick();fill(document.querySelector('input[placeholder="plugins/research/app.json"]'),'plugins/review/app.json');await tick();button('Preview bundle').click();await tick();check(document.body.textContent.includes('Review bundle'),'bundle preview visible');
      button('Import disabled').click();await tick();check(window.calls.some(call=>call.workflowId==='runtime_apps_install'&&call.input.expectedDigest==='pinned-digest'),'bundle import pins preview digest');
      button('Settings').click();await tick();button('New preset').click();await tick();fill(document.querySelector('input[maxlength="80"]'),'Quick review');fill(document.querySelector('input[maxlength="256"]'),'provider/model');await tick();button('Save preset').click();await tick();check(window.profiles[0].modelId==='provider/model','preset save workflow');
      button('Use preset').click();await tick();check(window.preset.modelId==='provider/model','preset selection event');check(window.closedSettings===true,'preset selection closes settings');return passed;
    })()`);
    console.log(`RUNTIME_SETTINGS_RESULT ${JSON.stringify({ passed })}`);
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
  finally { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} }
})();
