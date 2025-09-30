// backend/utils/imageProcessor.js
import crypto from "crypto";
import fs from "fs/promises";
import sharp from "sharp";

const TARGET_SIZE = 2048; // Max dimension for processed images
const MIN_SIZE = 512; // Minimum dimension to accept
const JPEG_QUALITY = 90; // Quality for JPEG output

/**
 * Process a single image: resize, convert format, optimize
 */
export async function processImage(inputPath, outputPath) {
	try {
		console.log("🔄 [PROCESS] Starting image processing...");
		console.log("📂 [PROCESS] Input path:", inputPath);
		console.log("📂 [PROCESS] Output path:", outputPath);

		const startTime = Date.now();

		// Get image metadata
		console.log("📊 [PROCESS] Reading image metadata...");
		const metadata = await sharp(inputPath).metadata();
		console.log("✅ [PROCESS] Metadata read:", {
			width: metadata.width,
			height: metadata.height,
			format: metadata.format,
			space: metadata.space,
		});

		// Validate image
		console.log("🔍 [PROCESS] Validating image...");
		const validation = validateImage(metadata);
		if (!validation.valid) {
			console.error("❌ [PROCESS] Validation failed:", validation.error);
			throw new Error(`Image validation failed: ${validation.error}`);
		}
		console.log("✅ [PROCESS] Image validation passed");

		// Calculate new dimensions maintaining aspect ratio
		const { width, height } = metadata;
		let newWidth, newHeight;

		if (width > height) {
			newWidth = Math.min(width, TARGET_SIZE);
			newHeight = Math.round((height / width) * newWidth);
		} else {
			newHeight = Math.min(height, TARGET_SIZE);
			newWidth = Math.round((width / height) * newHeight);
		}

		console.log("📐 [PROCESS] Calculated dimensions:");
		console.log("   Original:", `${width}x${height}`);
		console.log("   New:", `${newWidth}x${newHeight}`);

		// Process image
		console.log("⚙️  [PROCESS] Starting Sharp processing...");
		await sharp(inputPath)
			.resize(newWidth, newHeight, {
				fit: "inside",
				withoutEnlargement: true,
			})
			.jpeg({ quality: JPEG_QUALITY })
			.toFile(outputPath);

		console.log("✅ [PROCESS] Sharp processing complete");

		// Get processed image info
		console.log("📊 [PROCESS] Reading processed image stats...");
		const processedMetadata = await sharp(outputPath).metadata();
		const processedStats = await fs.stat(outputPath);
		const originalStats = await fs.stat(inputPath);

		const processingTime = Date.now() - startTime;

		const result = {
			success: true,
			original: {
				width: metadata.width,
				height: metadata.height,
				format: metadata.format,
				fileSize: originalStats.size,
			},
			processed: {
				width: processedMetadata.width,
				height: processedMetadata.height,
				format: processedMetadata.format,
				fileSize: processedStats.size,
			},
			processingTime,
		};

		console.log("✅ [PROCESS] Processing successful:");
		console.log("   Time:", `${processingTime}ms`);
		console.log("   Size reduction:", `${originalStats.size} -> ${processedStats.size} bytes`);
		console.log("   Compression:", `${((1 - processedStats.size / originalStats.size) * 100).toFixed(1)}%`);

		return result;
	} catch (error) {
		console.error("❌ [PROCESS] Processing failed:");
		console.error("   Error:", error.message);
		console.error("   Stack:", error.stack);
		return {
			success: false,
			error: error.message,
		};
	}
}

/**
 * Validate image meets requirements
 */
function validateImage(metadata) {
	console.log("🔍 [VALIDATE] Starting validation...");

	if (!metadata) {
		console.error("❌ [VALIDATE] No metadata provided");
		return { valid: false, error: "Unable to read image metadata" };
	}

	if (!metadata.width || !metadata.height) {
		console.error("❌ [VALIDATE] Invalid dimensions:", { width: metadata.width, height: metadata.height });
		return { valid: false, error: "Invalid image dimensions" };
	}

	const minDimension = Math.min(metadata.width, metadata.height);
	console.log("📏 [VALIDATE] Min dimension:", minDimension, "Required:", MIN_SIZE);

	if (minDimension < MIN_SIZE) {
		return {
			valid: false,
			error: `Image too small. Minimum dimension is ${MIN_SIZE}px, got ${minDimension}px`,
		};
	}

	const validFormats = ["jpeg", "jpg", "png", "webp", "tiff", "gif"];
	const format = metadata.format?.toLowerCase();
	console.log("🎨 [VALIDATE] Format:", format, "Valid formats:", validFormats);

	if (!validFormats.includes(format)) {
		return {
			valid: false,
			error: `Invalid format: ${metadata.format}. Supported: ${validFormats.join(", ")}`,
		};
	}

	console.log("✅ [VALIDATE] Validation passed");
	return { valid: true };
}

/**
 * Generate hash for duplicate detection
 */
export async function generateImageHash(filePath) {
	try {
		console.log("🔐 [HASH] Generating hash for:", filePath);

		// Resize to small size and generate hash for quick comparison
		const buffer = await sharp(filePath).resize(8, 8, { fit: "fill" }).greyscale().raw().toBuffer();

		const hash = crypto.createHash("md5").update(buffer).digest("hex");
		console.log("✅ [HASH] Hash generated:", hash.substring(0, 8) + "...");

		return hash;
	} catch (error) {
		console.error("❌ [HASH] Failed to generate hash:", error.message);
		throw new Error(`Failed to generate hash: ${error.message}`);
	}
}

/**
 * Check if image is corrupted
 */
export async function isImageCorrupted(filePath) {
	try {
		console.log("🔍 [CORRUPT] Checking if image is corrupted:", filePath);
		await sharp(filePath).metadata();
		console.log("✅ [CORRUPT] Image is valid");
		return false;
	} catch (error) {
		console.error("❌ [CORRUPT] Image is corrupted:", error.message);
		return true;
	}
}

/**
 * Get image info without processing
 */
export async function getImageInfo(filePath) {
	try {
		console.log("ℹ️  [INFO] Getting image info:", filePath);

		const metadata = await sharp(filePath).metadata();
		const stats = await fs.stat(filePath);

		const info = {
			width: metadata.width,
			height: metadata.height,
			format: metadata.format,
			space: metadata.space,
			channels: metadata.channels,
			hasAlpha: metadata.hasAlpha,
			fileSize: stats.size,
			fileSizeFormatted: formatFileSize(stats.size),
		};

		console.log("✅ [INFO] Image info retrieved:", info);
		return info;
	} catch (error) {
		console.error("❌ [INFO] Failed to get image info:", error.message);
		throw new Error(`Failed to get image info: ${error.message}`);
	}
}

/**
 * Format file size to human readable
 */
function formatFileSize(bytes) {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Save processing metadata
 */
export async function saveMetadata(metadataPath, data) {
	try {
		console.log("💾 [META] Saving metadata to:", metadataPath);
		await fs.writeFile(metadataPath, JSON.stringify(data, null, 2));
		console.log("✅ [META] Metadata saved successfully");
		return true;
	} catch (error) {
		console.error("❌ [META] Failed to save metadata:", error);
		return false;
	}
}
