// Generic ffmpeg helpers: normalize a raw Playwright webm capture into a
// clean MP4, and pull verification stills / ffprobe facts. No scenario
// knowledge here — just capture-file plumbing reusable across projects.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/** Re-encode a raw capture (webm/mov/etc.) to h264/yuv420p +faststart MP4, no audio. */
function normalizeToMp4(inputPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    outputPath,
  ], { stdio: 'inherit' });
}

/** Extract a still frame at `atSeconds` into `outPath`. */
function extractStill(videoPath, atSeconds, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-ss', String(atSeconds), '-i', videoPath,
    '-update', '1', '-frames:v', '1', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Return { width, height, codec_name, pix_fmt, duration } via ffprobe. */
function probe(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,pix_fmt',
    '-show_entries', 'format=duration',
    '-of', 'json', videoPath,
  ]).toString();
  const data = JSON.parse(out);
  const stream = data.streams?.[0] ?? {};
  return {
    width: stream.width,
    height: stream.height,
    codec_name: stream.codec_name,
    pix_fmt: stream.pix_fmt,
    duration: Number(data.format?.duration),
  };
}

module.exports = { normalizeToMp4, extractStill, probe };
