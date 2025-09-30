import cors from "cors";
import express from "express";
import fs from "fs/promises";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import { generateImageHash, getImageInfo, isImageCorrupted, processImage, saveMetadata } from "./utils/imageProcessor.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Create required directories
const createDirectories = async () => {
	const dirs = ["./uploads", "./processed/originals", "./processed/resized", "./processed/metadata"];

	for (const dir of dirs) {
		try {
			await fs.mkdir(dir, { recursive: true });
			console.log(`✅ ${dir} directory ready`);
		} catch (error) {
			console.log(`📁 ${dir} already exists`);
		}
	}
};
createDirectories();

// Configure multer for file uploads
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, "./uploads");
	},
	filename: (req, file, cb) => {
		const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
		cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
	},
});

const upload = multer({
	storage: storage,
	limits: {
		fileSize: 10 * 1024 * 1024,
		files: 10,
	},
	fileFilter: (req, file, cb) => {
		if (file.mimetype.startsWith("image/")) {
			cb(null, true);
		} else {
			cb(new Error("Only image files are allowed!"), false);
		}
	},
});

// ========================================
// EXISTING ENDPOINTS (from Step 2)
// ========================================

app.get("/test", (req, res) => {
	res.json({
		message: "Backend server is running - Step 3!",
		timestamp: new Date().toISOString(),
		features: ["File Upload", "Image Processing"],
		endpoints: [
			"GET  /test - Health check",
			"GET  /check-n8n - Test n8n connection",
			"POST /send-to-n8n - Send data to n8n",
			"POST /upload-images - Upload image files",
			"GET  /uploads - List uploaded files",
			"POST /process-images - Process uploaded images (NEW)",
			"GET  /processed-images - List processed images (NEW)",
			"POST /validate-image - Validate single image (NEW)",
		],
	});
});

app.get("/check-n8n", async (req, res) => {
	try {
		const response = await fetch("http://localhost:5678/webhook/from-backend", {
			method: "GET",
		});
		res.json({
			n8nStatus: response.status === 200 ? "Connected" : "Not responding",
			statusCode: response.status,
		});
	} catch (err) {
		res.json({
			n8nStatus: "Connection failed",
			error: err.message,
		});
	}
});

app.post("/upload-images", upload.array("images", 10), async (req, res) => {
	try {
		if (!req.files || req.files.length === 0) {
			return res.status(400).json({
				success: false,
				error: "No files uploaded",
			});
		}

		console.log(`📤 Received ${req.files.length} files for upload`);

		const uploadData = {
			uploadId: Date.now().toString(),
			totalFiles: req.files.length,
			files: req.files.map((file) => ({
				originalName: file.originalname,
				filename: file.filename,
				size: file.size,
				mimetype: file.mimetype,
				path: file.path,
				uploadedAt: new Date().toISOString(),
			})),
			metadata: {
				uploadTime: new Date().toISOString(),
				userAgent: req.get("user-agent"),
				ip: req.ip,
			},
		};
		console.log(uploadData)

		console.log("📨 Sending file metadata to n8n...");

		try {
			const n8nResponse = await fetch("http://localhost:5678/webhook/process-upload", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(uploadData),
			});

			let n8nData = "No response from n8n";
			let n8nSuccess = false;

			if (n8nResponse.ok) {
				const contentType = n8nResponse.headers.get("content-type");
				if (contentType && contentType.includes("application/json")) {
					n8nData = await n8nResponse.json();
					n8nSuccess = true;
				} else {
					n8nData = await n8nResponse.text();
				}
				console.log("✅ n8n processing started successfully");
			}

			res.json({
				success: true,
				uploadId: uploadData.uploadId,
				filesUploaded: req.files.length,
				files: req.files.map((f) => ({
					originalName: f.originalname,
					filename: f.filename,
					size: f.size,
					mimetype: f.mimetype,
				})),
				n8nProcessing: n8nSuccess ? "Started" : "Failed",
				n8nResponse: n8nData,
				message: `Successfully uploaded ${req.files.length} files`,
			});
		} catch (n8nError) {
			console.error("n8n connection error:", n8nError.message);

			res.json({
				success: true,
				uploadId: uploadData.uploadId,
				filesUploaded: req.files.length,
				files: req.files.map((f) => ({
					originalName: f.originalname,
					filename: f.filename,
					size: f.size,
					mimetype: f.mimetype,
				})),
				n8nProcessing: "Failed",
				n8nError: n8nError.message,
				message: `Files uploaded successfully, but n8n processing failed: ${n8nError.message}`,
			});
		}
	} catch (error) {
		console.error("❌ Upload error:", error);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.get("/uploads", async (req, res) => {
	try {
		const files = await fs.readdir("./uploads");
		const fileDetails = [];

		for (const file of files) {
			try {
				const stats = await fs.stat(path.join("./uploads", file));
				fileDetails.push({
					filename: file,
					size: stats.size,
					sizeFormatted: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
					uploadTime: stats.mtime,
					isImage: /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(file),
				});
			} catch (err) {
				console.log(`Error reading file ${file}:`, err.message);
			}
		}

		fileDetails.sort((a, b) => new Date(b.uploadTime) - new Date(a.uploadTime));

		res.json({
			success: true,
			totalFiles: fileDetails.length,
			files: fileDetails,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// ========================================
// NEW ENDPOINTS (Step 3 - Image Processing)
// ========================================

// Process uploaded images
app.post("/process-images", async (req, res) => {
	try {
		const { uploadId, filenames } = req.body;

		console.log(`🔄 Starting image processing...`);

		// Get files to process
		let filesToProcess;
		if (filenames && Array.isArray(filenames)) {
			filesToProcess = filenames;
		} else {
			// Process all files in uploads directory
			filesToProcess = await fs.readdir("./uploads");
		}

		const results = [];
		const hashes = new Set();
		const duplicates = [];

		for (const filename of filesToProcess) {
			try {
				const inputPath = path.join("./uploads", filename);
				const originalPath = path.join("./processed/originals", filename);
				const processedFilename = filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_processed.jpg");
				const processedPath = path.join("./processed/resized", processedFilename);
				const metadataPath = path.join("./processed/metadata", filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_meta.json"));

				// Check if file is corrupted
				const corrupted = await isImageCorrupted(inputPath);
				if (corrupted) {
					results.push({
						filename,
						success: false,
						error: "Image file is corrupted or invalid",
					});
					continue;
				}

				// Generate hash for duplicate detection
				const hash = await generateImageHash(inputPath);
				if (hashes.has(hash)) {
					duplicates.push(filename);
					results.push({
						filename,
						success: false,
						error: "Duplicate image detected",
						hash,
					});
					continue;
				}
				hashes.add(hash);

				// Copy original to backup
				await fs.copyFile(inputPath, originalPath);

				// Process image
				const processResult = await processImage(inputPath, processedPath);

				if (!processResult.success) {
					results.push({
						filename,
						success: false,
						error: processResult.error,
					});
					continue;
				}

				// Save metadata
				const metadata = {
					originalFile: filename,
					processedFile: processedFilename,
					uploadId: uploadId || "unknown",
					originalSize: processResult.original,
					processedSize: processResult.processed,
					hash,
					processedAt: new Date().toISOString(),
					processingTime: processResult.processingTime,
				};

				await saveMetadata(metadataPath, metadata);

				results.push({
					filename,
					success: true,
					...processResult,
					hash,
					paths: {
						original: originalPath,
						processed: processedPath,
						metadata: metadataPath,
					},
				});

				console.log(`✅ Processed: ${filename}`);
			} catch (error) {
				results.push({
					filename,
					success: false,
					error: error.message,
				});
				console.error(`❌ Failed to process ${filename}:`, error.message);
			}
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		res.json({
			success: true,
			uploadId: uploadId || "batch",
			totalFiles: filesToProcess.length,
			processed: successful,
			failed,
			duplicates: duplicates.length,
			duplicateFiles: duplicates,
			results,
		});
	} catch (error) {
		console.error("❌ Processing error:", error);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Get list of processed images
// Replace the /process-images endpoint in your server.js with this version

app.post("/process-images", async (req, res) => {
	try {
		const { uploadId, filenames } = req.body;

		console.log("\n🚀 ========== STARTING IMAGE PROCESSING ==========");
		console.log("📦 Request body:", { uploadId, filenames });

		// Get files to process
		let filesToProcess;
		if (filenames && Array.isArray(filenames)) {
			filesToProcess = filenames;
			console.log(`📁 Processing specific files (${filenames.length}):`, filenames);
		} else {
			// Process all files in uploads directory
			filesToProcess = await fs.readdir("./uploads");
			console.log(`📁 Processing all files in uploads (${filesToProcess.length}):`, filesToProcess);
		}

		const results = [];
		const hashes = new Set();
		const duplicates = [];

		console.log(`\n🔄 Starting batch processing of ${filesToProcess.length} files...\n`);

		for (let i = 0; i < filesToProcess.length; i++) {
			const filename = filesToProcess[i];
			console.log(`\n📸 [${i + 1}/${filesToProcess.length}] Processing: ${filename}`);
			console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

			try {
				const inputPath = path.join("./uploads", filename);
				const originalPath = path.join("./processed/originals", filename);
				const processedFilename = filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_processed.jpg");
				const processedPath = path.join("./processed/resized", processedFilename);
				const metadataPath = path.join("./processed/metadata", filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_meta.json"));

				console.log("📂 Paths:");
				console.log("   Input:", inputPath);
				console.log("   Original backup:", originalPath);
				console.log("   Processed output:", processedPath);
				console.log("   Metadata:", metadataPath);

				// Check if file exists
				try {
					await fs.access(inputPath);
					console.log("✅ Input file exists");
				} catch (error) {
					console.error("❌ Input file not found:", inputPath);
					results.push({
						filename,
						success: false,
						error: "Input file not found"
					});
					continue;
				}

				// Check if file is corrupted
				console.log("🔍 Checking for corruption...");
				const corrupted = await isImageCorrupted(inputPath);
				if (corrupted) {
					console.error("❌ Image is corrupted");
					results.push({
						filename,
						success: false,
						error: "Image file is corrupted or invalid",
					});
					continue;
				}
				console.log("✅ Image is not corrupted");

				// Generate hash for duplicate detection
				console.log("🔐 Generating hash...");
				const hash = await generateImageHash(inputPath);
				console.log(`   Hash: ${hash.substring(0, 16)}...`);
				
				if (hashes.has(hash)) {
					console.warn("⚠️  Duplicate detected!");
					duplicates.push(filename);
					results.push({
						filename,
						success: false,
						error: "Duplicate image detected",
						hash,
					});
					continue;
				}
				hashes.add(hash);
				console.log("✅ No duplicate found");

				// Copy original to backup
				console.log("📋 Backing up original...");
				await fs.copyFile(inputPath, originalPath);
				console.log("✅ Original backed up to:", originalPath);

				// Process image
				console.log("⚙️  Starting image processing...");
				const processResult = await processImage(inputPath, processedPath);

				if (!processResult.success) {
					console.error("❌ Processing failed:", processResult.error);
					results.push({
						filename,
						success: false,
						error: processResult.error,
					});
					continue;
				}

				console.log("✅ Image processing successful!");

				// Verify processed file exists
				try {
					const processedStats = await fs.stat(processedPath);
					console.log("✅ Processed file created:", processedPath);
					console.log("   Size:", processedStats.size, "bytes");
				} catch (error) {
					console.error("❌ Processed file not found after processing!", processedPath);
					results.push({
						filename,
						success: false,
						error: "Processed file not created"
					});
					continue;
				}

				// Save metadata
				console.log("💾 Saving metadata...");
				const metadata = {
					originalFile: filename,
					processedFile: processedFilename,
					uploadId: uploadId || "unknown",
					originalSize: processResult.original,
					processedSize: processResult.processed,
					hash,
					processedAt: new Date().toISOString(),
					processingTime: processResult.processingTime,
				};

				const metaSaved = await saveMetadata(metadataPath, metadata);
				if (metaSaved) {
					console.log("✅ Metadata saved");
				} else {
					console.warn("⚠️  Metadata save failed (continuing anyway)");
				}

				results.push({
					filename,
					success: true,
					...processResult,
					hash,
					paths: {
						original: originalPath,
						processed: processedPath,
						metadata: metadataPath,
					},
				});

				console.log(`✅ [${i + 1}/${filesToProcess.length}] Successfully processed: ${filename}`);

			} catch (error) {
				console.error(`❌ [${i + 1}/${filesToProcess.length}] Error processing ${filename}:`, error.message);
				console.error("   Stack:", error.stack);
				results.push({
					filename,
					success: false,
					error: error.message,
				});
			}
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log("\n✅ ========== PROCESSING COMPLETE ==========");
		console.log(`📊 Summary:`);
		console.log(`   Total: ${filesToProcess.length}`);
		console.log(`   Successful: ${successful}`);
		console.log(`   Failed: ${failed}`);
		console.log(`   Duplicates: ${duplicates.length}`);
		console.log("============================================\n");

		res.json({
			success: true,
			uploadId: uploadId || "batch",
			totalFiles: filesToProcess.length,
			processed: successful,
			failed,
			duplicates: duplicates.length,
			duplicateFiles: duplicates,
			results,
		});
	} catch (error) {
		console.error("\n❌ ========== PROCESSING ERROR ==========");
		console.error("Error:", error.message);
		console.error("Stack:", error.stack);
		console.error("=========================================\n");
		
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Validate a single image
app.post("/validate-image", upload.single("image"), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				success: false,
				error: "No image file provided",
			});
		}

		const corrupted = await isImageCorrupted(req.file.path);
		if (corrupted) {
			await fs.unlink(req.file.path);
			return res.json({
				success: false,
				valid: false,
				error: "Image is corrupted or invalid",
			});
		}

		const info = await getImageInfo(req.file.path);
		await fs.unlink(req.file.path);

		res.json({
			success: true,
			valid: true,
			imageInfo: info,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Error handling middleware
app.use((error, req, res, next) => {
	if (error instanceof multer.MulterError) {
		if (error.code === "LIMIT_FILE_SIZE") {
			return res.status(400).json({
				success: false,
				error: "File too large. Maximum size is 10MB.",
			});
		}
		if (error.code === "LIMIT_FILE_COUNT") {
			return res.status(400).json({
				success: false,
				error: "Too many files. Maximum is 10 files at once.",
			});
		}
	}

	if (error.message === "Only image files are allowed!") {
		return res.status(400).json({
			success: false,
			error: "Only image files are allowed (jpg, png, gif, etc.)",
		});
	}

	res.status(500).json({
		success: false,
		error: error.message,
	});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`🚀 Backend server running on http://localhost:${PORT}`);
	// console.log(`📊 Step 3: File Upload + Image Processing`);
	// console.log(`📁 Directories:`);
	// console.log(`   - uploads/ (raw uploads)`);
	// console.log(`   - processed/originals/ (backup)`);
	// console.log(`   - processed/resized/ (2048px processed)`);
	// console.log(`   - processed/metadata/ (processing info)`);
	// console.log(`🔗 API endpoints ready`);
});
