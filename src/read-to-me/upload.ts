import { gcsClient } from './clients';

/**
 * Upload a file to Google Cloud Storage.
 * @param localPath - Local file path to upload
 * @param gcsPath - Destination path in format "bucket/path/to/file"
 * @param contentType - Optional content type override
 */
export async function uploadToGCS(localPath: string, gcsPath: string, contentType?: string): Promise<void> {
    // Parse gcsPath: first segment is bucket, rest is the object path
    const parts = gcsPath.split('/');
    const bucketName = parts[0];
    const objectPath = parts.slice(1).join('/');

    const bucket = gcsClient.bucket(bucketName);
    await bucket.upload(localPath, {
        destination: objectPath,
        ...(contentType && { contentType }),
    });
}
