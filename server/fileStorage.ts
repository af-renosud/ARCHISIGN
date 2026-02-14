import { objectStorageClient } from "./replit_integrations/object_storage/objectStorage";
import type { Response } from "express";

function getBucketAndPrefix(): { bucketName: string; prefix: string } {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const parts = dir.replace(/^\//, "").split("/");
  const bucketName = parts[0];
  const prefix = parts.slice(1).join("/");
  return { bucketName, prefix: prefix ? prefix + "/" : "" };
}

export async function uploadFile(fileName: string, data: Buffer, contentType: string = "application/pdf"): Promise<string> {
  // Upload to Object Storage under the private dir
  // Returns the object path like "/uploads/filename.pdf" for DB storage
  const { bucketName, prefix } = getBucketAndPrefix();
  const objectName = `${prefix}uploads/${fileName}`;
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(data, { contentType });
  return `/uploads/${fileName}`;
}

export async function downloadFile(urlPath: string): Promise<{ data: Buffer; contentType: string } | null> {
  // Download a file given its URL path (e.g. "/uploads/abc123.pdf")
  // Returns null if file doesn't exist
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const fileName = urlPath.replace(/^\/uploads\//, "");
    const objectName = `${prefix}uploads/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [data] = await file.download();
    const [metadata] = await file.getMetadata();
    return { data, contentType: metadata.contentType || "application/pdf" };
  } catch {
    return null;
  }
}

export async function fileExists(urlPath: string): Promise<boolean> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const fileName = urlPath.replace(/^\/uploads\//, "");
    const objectName = `${prefix}uploads/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    return exists;
  } catch {
    return false;
  }
}

export async function streamFileToResponse(urlPath: string, res: Response): Promise<boolean> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const fileName = urlPath.replace(/^\/uploads\//, "");
    const objectName = `${prefix}uploads/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) return false;
    const [metadata] = await file.getMetadata();
    res.setHeader("Content-Type", metadata.contentType || "application/pdf");
    if (metadata.size) res.setHeader("Content-Length", metadata.size);
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.status(500).json({ message: "Error streaming file" });
      }
    });
    stream.pipe(res);
    return true;
  } catch {
    return false;
  }
}

export async function deleteFile(urlPath: string): Promise<void> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const fileName = urlPath.replace(/^\/uploads\//, "");
    const objectName = `${prefix}uploads/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.delete({ ignoreNotFound: true });
  } catch {
    // Ignore errors
  }
}

// For backups
export async function uploadBackup(fileName: string, data: string): Promise<string> {
  const { bucketName, prefix } = getBucketAndPrefix();
  const objectName = `${prefix}backups/${fileName}`;
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(data, { contentType: "application/json" });
  return fileName;
}

export async function downloadBackup(fileName: string): Promise<string | null> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const objectName = `${prefix}backups/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [data] = await file.download();
    return data.toString("utf-8");
  } catch {
    return null;
  }
}

export async function deleteBackupFile(fileName: string): Promise<void> {
  try {
    const { bucketName, prefix } = getBucketAndPrefix();
    const objectName = `${prefix}backups/${fileName}`;
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    await file.delete({ ignoreNotFound: true });
  } catch {
    // Ignore errors
  }
}
