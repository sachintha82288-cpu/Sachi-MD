const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../../config');
function tempDirs() { return [config.paths.temp, os.tmpdir()]; }
function human(n) { n=Number(n)||0; if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB'; if(n>=1048576)return (n/1048576).toFixed(1)+' MB'; if(n>=1024)return (n/1024).toFixed(1)+' KB'; return n+' B'; }
function diskInfo() { return new Promise(resolve => execFile('df',['-kP',config.paths.root],(e,stdout)=>{ if(e)return resolve(null); const lines=String(stdout).trim().split('\n'); const p=lines[lines.length-1].trim().split(/\s+/); if(p.length<6)return resolve(null); resolve({total:Number(p[1])*1024,used:Number(p[2])*1024,free:Number(p[3])*1024,mount:p.slice(5).join(' ')}); })); }
function listTemp() { const out=[]; for(const dir of tempDirs()){ let names=[]; try{names=fs.readdirSync(dir);}catch{continue;} for(const name of names){ if(!/^((wa-|sachi-)|.*\.(part|ytdl|tmp)$)/i.test(name))continue; const p=path.join(dir,name); try{const st=fs.statSync(p); if(st.isFile())out.push({path:p,name,size:st.size,mtime:st.mtimeMs});}catch{} } } return out; }
function cleanup(force=false){ const age=2*60*60*1000, now=Date.now(); let count=0,freed=0; for(const f of listTemp()){if(!force&&now-f.mtime<age)continue;try{fs.unlinkSync(f.path);count++;freed+=f.size;}catch{}} return {count,freed}; }
module.exports={human,diskInfo,listTemp,cleanup};
