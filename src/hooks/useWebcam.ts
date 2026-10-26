import { useState, useCallback } from 'react';

export const useWebcam = () => {
    const [isScanning, setIsScanning] = useState(false);

    const captureFrame = useCallback(async (): Promise<string | null> => {
        setIsScanning(true);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
            
            return new Promise((resolve) => {
                const video = document.createElement('video');
                video.srcObject = stream;
                video.play();

                // Wait for the video to be ready before drawing to canvas
                video.onloadeddata = () => {
                    setTimeout(() => {
                        const canvas = document.createElement('canvas');
                        canvas.width = video.videoWidth;
                        canvas.height = video.videoHeight;
                        
                        const ctx = canvas.getContext('2d');
                        if (ctx) {
                            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                            const base64 = canvas.toDataURL('image/jpeg', 0.8);
                            
                            // Immediately stop all tracks to turn off the camera light
                            stream.getTracks().forEach(track => track.stop());
                            setIsScanning(false);
                            
                            resolve(base64);
                        } else {
                            stream.getTracks().forEach(track => track.stop());
                            setIsScanning(false);
                            resolve(null);
                        }
                    }, 500); // 500ms delay to let auto-exposure adjust
                };

                video.onerror = () => {
                    stream.getTracks().forEach(track => track.stop());
                    setIsScanning(false);
                    resolve(null);
                };
            });
        } catch (error) {
            console.error("Webcam access denied or failed:", error);
            setIsScanning(false);
            return null;
        }
    }, []);

    return { captureFrame, isScanning };
};
