const ffmpeg_static = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const express = require('express');
const ytdl = require('ytdl-core');
const zipdir = require('zip-dir');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const APP_PORT = process.env.PORT || `5000`;
const DOWNLOAD_ROUTE = `download`;
const OUT_DIRECTORY = `./out`;
const OUT_FORMAT = `mp3`;

const app = express();
app.use('/', express.static('ui'));
app.use(`/${DOWNLOAD_ROUTE}`, express.static('out'));

const WSServer = WebSocket.Server;
const server = http.createServer();
const wss = new WSServer({
    server: server,
    perMessageDeflate: false
});
server.on('request', app);

const localDir = (dir) => {
    !fs.existsSync(OUT_DIRECTORY) && fs.mkdirSync(OUT_DIRECTORY);
    !fs.existsSync(dir) && fs.mkdirSync(dir);
    return dir;
};

const getStartSeconds = (startTime) => {
    startTime = startTime.split(':').length == 2 ? `00:${startTime}` : startTime;
    return Math.abs(new Date(`2019/10/1 00:00:00`) - new Date(`2019/10/1 ${startTime}`)) / 1000;
};

const getDynamicTracksList = (feededTracks) => {
    try {
        feededTracks = feededTracks.split('\n').filter(t => !!t);
        return feededTracks.map((track, index) => {
            let [title, start] = track.split('-');
            return {
                title: title.trim(),
                start_time: index == 0 ? 0 : getStartSeconds(start)
            };
        });
    } catch (error) {
        console.log('getDynamicTracksList::', error);
        throw Error('Error in provided tracklist info !!');
    }
};

const getVideoInfo = (source) => ytdl.getInfo(source)
    .then(({ videoDetails: { chapters = [], lengthSeconds, videoId } = {} }) => ({ chapters, lengthSeconds, videoId }))
    .catch((err) => {
        console.log('getVideoInfo::', err);
        throw Error('Error retrieving info with provided url !!');
    });

const downloadVideoAndConvertToMp3 = (source, videoId) => new Promise((resolve, reject) => {
    let outDir = localDir(`${OUT_DIRECTORY}/${videoId}`);
    ffmpeg(ytdl(source))
        .setFfmpegPath(ffmpeg_static)
        .toFormat(OUT_FORMAT)
        .saveToFile(`${outDir}/complete.${OUT_FORMAT}`)
        .on('end', () => resolve())
        .on('error', (err) => {
            console.log('downloadVideoAndConvertToMp3', err);
            reject(new Error('Error retrieving complete audio !!'))
        });
});

const splitAudio = (startTime, duration, title, videoId) => new Promise((resolve, reject) => {
    let outDir = localDir(`${OUT_DIRECTORY}/${videoId}/splitted`);
    ffmpeg(`${OUT_DIRECTORY}/${videoId}/complete.${OUT_FORMAT}`)
        .setFfmpegPath(ffmpeg_static)
        .setStartTime(startTime)
        .duration(duration)
        .saveToFile(`${outDir}/${title.replace(/[^a-z0-9_-]/gi, '_')}.mp3`)
        .on('end', () => resolve(outDir))
        .on('error', (err) => {
            console.log('splitAudio', err);
            reject(new Error('Error splitting audio tracks !!'));
        });
});

const generateTracks = async (source, tracks) => {
    let { chapters, lengthSeconds, videoId } = await getVideoInfo(source);
    console.log(`ytdl infos extracted: ${videoId} - ${lengthSeconds}s`);
    await downloadVideoAndConvertToMp3(source, videoId);
    console.log('Complete file downloaded !!');
    chapters = tracks ? getDynamicTracksList(tracks) : chapters;
    console.log('Track List being processed ::', chapters);
    if (chapters.length == 0) throw Error('Error in provided empty tracklist info !!');
    let tracksList = [];
    chapters.forEach(async (chapter, index, array) => {
        const startTime = new Date(chapter.start_time * 1000).toISOString().substr(11, 8);
        const duration = array.length - 1 == index ? lengthSeconds : (array[index + 1].start_time - 1) - chapter.start_time;
        tracksList.push(splitAudio(startTime, duration, chapter.title, videoId));
    });
    const [splittedTracksPath] = await Promise.all(tracksList);
    console.log('Tracks splitted successfully !!');
    const zipPath = `${OUT_DIRECTORY}/${videoId}/splitted.zip`;
    console.log({ splittedTracksPath, zipPath });
    await zipdir(splittedTracksPath, { saveTo: zipPath });
    console.log('Tracks zipped successfully !!');
    return `${videoId}/splitted.zip`;
};



wss.on('connection', function connection(ws) {
    console.log('App connected with socket...');

    ws.on('message', async function incoming(message) {
        try {
            const { url, tracks } = JSON.parse(message);
            if (url || tracks) {
                console.log(`Download request received: `, url, tracks);
                const zippedPath = await generateTracks(url, tracks);
                console.log('Tracks generated successfully !!');
                ws.send(JSON.stringify({ downloadUrl: `./${DOWNLOAD_ROUTE}/${zippedPath}` }));
            } else {
                console.log('Health check request received !!');
                ws.send(JSON.stringify({ health: 'server alive' }));
            }
        } catch (error) {
            console.log('/convert :: ', error.message);
            ws.send(JSON.stringify({ message: error.message }));
        }
    });
});

server.listen(APP_PORT, () => console.log(`http://localhost:${APP_PORT}`));
