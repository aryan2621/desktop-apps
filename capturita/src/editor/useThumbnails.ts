import { useEffect, useState } from 'react';
import { fileUrl, type Project } from '../lib/api';

export interface Thumbnail {
    /** Source time of the frame. */
    time: number;
    url: string;
}

const THUMB_HEIGHT = 72;

/** Frames across the recording for the timeline, grabbed one by one from a hidden video. */
export function useThumbnails(project: Project) {
    const [thumbnails, setThumbnails] = useState<Thumbnail[]>([]);

    useEffect(() => {
        const { screen } = project.tracks;
        const count = Math.round(Math.min(40, Math.max(8, project.duration / 2)));
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.src = fileUrl(project, screen.file);
        const canvas = document.createElement('canvas');
        canvas.height = THUMB_HEIGHT * 2;
        canvas.width = Math.round((canvas.height * screen.width) / screen.height);
        const ctx = canvas.getContext('2d');
        let cancelled = false;

        const seek = (time: number) =>
            new Promise<void>((resolve) => {
                video.onseeked = () => resolve();
                video.currentTime = time;
            });

        (async () => {
            await new Promise<void>((resolve, reject) => {
                video.onloadeddata = () => resolve();
                video.onerror = () => reject(new Error('Could not load video for thumbnails'));
            });
            const results: Thumbnail[] = [];
            for (let i = 0; i < count && !cancelled; i++) {
                const time = Math.min(screen.duration - 0.05, ((i + 0.5) / count) * screen.duration);
                await seek(Math.max(0, time));
                if (cancelled || !ctx) break;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                results.push({ time: time + screen.offset, url: canvas.toDataURL('image/jpeg', 0.6) });
                setThumbnails([...results]);
            }
        })().catch(() => {});

        return () => {
            cancelled = true;
            video.removeAttribute('src');
            video.load();
        };
    }, [project]);

    return thumbnails;
}
