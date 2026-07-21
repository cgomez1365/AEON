/**
 * AEON Jarvis — Media Service
 * FFmpeg video stitch pipeline + optional YouTube upload.
 */
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { google } = require('googleapis');

ffmpeg.setFfmpegPath(ffmpegStatic);

module.exports = ({ ROOT, writeOSAudit }) => {

  const activeStreams = new Map();   // sessionId -> { fd, filePath }
  const processingJobs = new Map();  // sessionId -> { status, progress, result, error }

  async function finalizeVideoStitch({
    rawMp4Path, outputPath, sessionId, musicTheme = 'silence',
    title, description, privacyStatus, uploadToYoutube = 'false'
  }) {
    let audioInput = null;
    if (musicTheme && musicTheme !== 'silence') {
      const p = path.join(ROOT, 'public', 'music', `${musicTheme}.mp3`);
      if (fs.existsSync(p)) audioInput = p;
    }

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg().input(rawMp4Path);

      if (audioInput) {
        cmd = cmd.input(audioInput)
          .inputOptions(['-stream_loop', '-1'])
          .outputOptions([
            '-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0',
            '-shortest', '-movflags +faststart'
          ]);
      } else {
        cmd = cmd.outputOptions(['-c copy', '-movflags +faststart']);
      }

      cmd.save(outputPath)
        .on('start', (cmdline) => console.log('[AEON PIPELINE] FFmpeg finalize command:', cmdline))
        .on('end', () => { console.log(`[AEON PIPELINE] Finalize Complete: ${outputPath}`); resolve(); })
        .on('error', (err) => { console.error('[AEON PIPELINE] FFmpeg Error:', err.message); reject(err); });
    });

    try {
      if (fs.existsSync(rawMp4Path)) fs.unlinkSync(rawMp4Path);
    } catch (rmErr) {
      console.error(`[AEON PIPELINE] Cleanup error: ${rmErr.message}`);
    }

    writeOSAudit('VIDEO_STITCH', `Finalized ${sessionId} -> ${outputPath}`, 0, 0, 'AEON-SYS');

    if (uploadToYoutube === 'true' || uploadToYoutube === true) {
      const clientId = process.env.YOUTUBE_CLIENT_ID;
      const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
      const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

      if (!clientId || !clientSecret || !refreshToken) {
        return { success: true, path: outputPath, youtubeError: 'YouTube credentials not configured' };
      }

      try {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

        const response = await youtube.videos.insert({
          part: 'snippet,status',
          requestBody: {
            snippet: {
              title: title || 'AEON 4K Holographic Render',
              description: description || 'Generated via AEON Deterministic Frame Capture Pipeline.',
              tags: ['AEON', 'Hologram', 'WebGL', 'AI', 'Generative Art', '4K'],
              categoryId: '28'
            },
            status: { privacyStatus: privacyStatus || 'unlisted' }
          },
          media: { mimeType: 'video/mp4', body: fs.createReadStream(outputPath) }
        });

        console.log(`[AEON PIPELINE] YouTube Upload Success: https://youtu.be/${response.data.id}`);
        return { success: true, path: outputPath, videoId: response.data.id, url: `https://youtu.be/${response.data.id}` };
      } catch (ytErr) {
        console.error('[AEON PIPELINE] YouTube Upload Error:', ytErr.message);
        return { success: true, path: outputPath, youtubeError: ytErr.message };
      }
    }

    return { success: true, path: outputPath };
  }

  return { activeStreams, processingJobs, finalizeVideoStitch };
};
