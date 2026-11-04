const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const config = require('../../config');
const log = require('../../utils/logger');
const { ensureDir } = require('../../utils/files');
const BIN=config.paths.bin;
const paths={ytDlp:path.join(BIN,'yt-dlp'),ffmpeg:path.join(BIN,'ffmpeg'),xray:path.join(BIN,'xray')};
async function latestAssetUrl(repo, asset){const r=await axios.get(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{'User-Agent':'Sachi-MD'},timeout:20000});const a=(r.data.assets||[]).find(x=>x.name===asset);if(!a)throw new Error(`Missing release asset: ${asset}`);return a.browser_download_url;}
async function download(url,dest){ensureDir(path.dirname(dest));const r=await axios.get(url,{responseType:'stream',timeout:120000,headers:{'User-Agent':'Sachi-MD'}});await new Promise((res,rej)=>{const w=fs.createWriteStream(dest);r.data.pipe(w);r.data.on('error',rej);w.on('finish',res);w.on('error',rej);});fs.chmodSync(dest,0o755);}
/**
 * A binary on disk is not the same thing as a binary that runs.
 *
 * The old check was `fs.existsSync` and nothing else, so a restored backup, a
 * zip that lost its mode bits, or a half-finished download left a file behind
 * that every `spawn()` then failed to exec — and one of those call sites did
 * not handle the error event, which took the whole bot down. So: check the file
 * is executable, non-trivial in size, and actually runs before trusting it.
 */
async function usable(bin, probeArgs = ['--version']) {
  try {
    if (!fs.existsSync(bin)) return false;
    const st = fs.statSync(bin);
    if (!st.isFile() || st.size < 1024) { log.warn(`${path.basename(bin)} is empty or truncated — downloading it again`); return false; }
    // Lost exec bit (extracted from an archive, restored from a backup, …)
    try { fs.accessSync(bin, fs.constants.X_OK); }
    catch { fs.chmodSync(bin, 0o755); log.info(`${path.basename(bin)} was not executable — chmod +x applied`); }
    const { execFileSync } = require('child_process');
    execFileSync(bin, probeArgs, { timeout: 20000, stdio: 'ignore' });
    return true;
  } catch (e) {
    log.warn(`${path.basename(bin)} exists but does not run (${e.message.split('\n')[0]}) — downloading it again`);
    try { fs.rmSync(bin, { force: true }); } catch {}
    return false;
  }
}

async function ensureYtDlp(){
  if (await usable(paths.ytDlp)) return paths.ytDlp;
  log.info('Downloading yt-dlp binary...');
  await download(await latestAssetUrl('yt-dlp/yt-dlp','yt-dlp_linux'), paths.ytDlp);
  return paths.ytDlp;
}
async function ensureFfmpeg(){
  if (await usable(paths.ffmpeg, ['-version'])) return paths.ffmpeg;
  log.info('Downloading ffmpeg binary...');
  await download('https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-x64', paths.ffmpeg);
  return paths.ffmpeg;
}
async function ensureXray(){if(await usable(paths.xray,['version']))return paths.xray;log.info('Downloading Xray-core binary...');const zip=path.join(BIN,'xray.zip');await download(await latestAssetUrl('XTLS/Xray-core','Xray-linux-64.zip'),zip);await new Promise((res,rej)=>execFile('unzip',['-o','-j',zip,'xray','-d',BIN],e=>e?rej(e):res()));try{fs.unlinkSync(zip);}catch{}fs.chmodSync(paths.xray,0o755);return paths.xray;}
/**
 * A readable message for a failed helper download — "Request failed with
 * status code 404" tells the user nothing.
 */
function friendlyError(e, what='the helper binary') {
  const raw=String(e?.message||e||'');
  if(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(raw))
    return `Could not reach GitHub to download ${what} (no internet / DNS blocked).`;
  if(/404|not found/i.test(raw))
    return `${what} is not available for this platform right now.`;
  if(/403|rate limit/i.test(raw))
    return `GitHub rate-limited the download of ${what}. Try again in a few minutes.`;
  if(/EACCES|permission denied/i.test(raw))
    return `No permission to write ${what} into the bin folder.`;
  return raw;
}
module.exports={paths,ensureYtDlp,ensureFfmpeg,ensureXray,usable,friendlyError};
