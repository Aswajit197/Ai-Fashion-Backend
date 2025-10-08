import cors from "cors";
import express from "express";
import fs from "fs/promises";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import { generateImageHash, getImageInfo, isImageCorrupted, processImage, saveMetadata } from "./utils/imageProcessor.js";
// Add these imports at the top of server.js
import {
	checkComfyHealth,
	createImg2ImgWorkflow,
	createTextToImageWorkflow,
	downloadComfyOutput,
	getAvailableModels,
	getFashionPrompts,
	queuePrompt,
	uploadImageToComfy,
	waitForCompletion,
} from "./utils/comfyProcessor.js";

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
			// console.log(`✅ ${dir} directory ready`);
		} catch (error) {
			console.log(`📁 ${dir} already exists`);
		}
	}
};
createDirectories();

// Create no-background directory
const createNoBackgroundDir = async () => {
	try {
		await fs.mkdir("./processed/no-background", { recursive: true });
		console.log("✅ ./processed/no-background directory ready");
	} catch (error) {
		console.log("📁 ./processed/no-background already exists");
	}
};
createNoBackgroundDir();

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
// ========================================
app.get("/check-n8n", async (req, res) => {
	try {
		const response = await fetch("http://124.123.18.19:5678/webhook/from-backend", {
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
		console.log(uploadData);

		console.log("📨 Sending file metadata to n8n...");

		try {
			const n8nResponse = await fetch("http://124.123.18.19:5678/webhook/process-upload", {
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
	console.log("\n🚀 ========== Entering IMAGE PROCESSING ==========");
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
						error: "Input file not found",
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
						error: "Processed file not created",
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

// Remove background from processed images
app.post("/remove-background", async (req, res) => {
	console.log("\n🎨 ========== STARTING BACKGROUND REMOVAL ==========");
	try {
		const { filenames } = req.body;

		// Get files to process
		let filesToProcess;
		if (filenames && Array.isArray(filenames)) {
			filesToProcess = filenames;
			console.log(`📁 Processing specific files (${filenames.length}):`, filenames);
		} else {
			// Process all resized images
			const resizedFiles = await fs.readdir("./processed/resized");
			filesToProcess = resizedFiles.filter((f) => f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".png"));
			console.log(`📁 Processing all resized images (${filesToProcess.length})`);
		}

		if (filesToProcess.length === 0) {
			return res.json({
				success: false,
				error: "No images found to process. Make sure images are resized first.",
				hint: "Run POST /process-images first",
			});
		}

		const results = [];
		const FormData = (await import("form-data")).default;

		console.log(`\n🔄 Starting background removal for ${filesToProcess.length} files...\n`);

		for (let i = 0; i < filesToProcess.length; i++) {
			const filename = filesToProcess[i];
			console.log(`\n🎨 [${i + 1}/${filesToProcess.length}] Removing background: ${filename}`);
			console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

			try {
				const inputPath = path.join("./processed/resized", filename);
				const outputFilename = filename.replace(/\.(jpg|jpeg)$/i, "_no_bg.png");
				const outputPath = path.join("./processed/no-background", outputFilename);

				console.log("📂 Paths:");
				console.log("   Input:", inputPath);
				console.log("   Output:", outputPath);

				// Check if input file exists
				try {
					await fs.access(inputPath);
					console.log("✅ Input file exists");
				} catch (error) {
					console.error("❌ Input file not found:", inputPath);
					results.push({
						filename,
						success: false,
						error: "Input file not found",
					});
					continue;
				}

				// Check if rembg service is available
				console.log("🔍 Checking rembg service...");
				try {
					const healthCheck = await fetch("https://bhdv4f7q-5000.inc1.devtunnels.ms/health");
					if (!healthCheck.ok) {
						throw new Error("Service not healthy");
					}
					console.log("✅ rembg service is available");
				} catch (error) {
					console.error("❌ rembg service not available:", error.message);
					results.push({
						filename,
						success: false,
						error: "rembg service not available. Is Docker container running?",
					});
					continue;
				}

				// Prepare form data
				const formData = new FormData();
				const fileStream = await fs.readFile(inputPath);
				formData.append("image", fileStream, {
					filename: filename,
					contentType: "image/jpeg",
				});

				console.log("🚀 Sending to rembg service...");
				const startTime = Date.now();

				// Call rembg service
				const response = await fetch("https://bhdv4f7q-5000.inc1.devtunnels.ms/remove-background", {
					method: "POST",
					body: formData,
					headers: formData.getHeaders(),
				});

				if (!response.ok) {
					const errorText = await response.text();
					throw new Error(`rembg service error: ${response.status} - ${errorText}`);
				}

				// Save the result
				const buffer = await response.arrayBuffer();
				await fs.writeFile(outputPath, Buffer.from(buffer));

				const processingTime = Date.now() - startTime;

				// Get file stats
				const outputStats = await fs.stat(outputPath);

				console.log("✅ Background removed successfully!");
				console.log(`   Processing time: ${processingTime}ms`);
				console.log(`   Output size: ${(outputStats.size / 1024).toFixed(1)} KB`);

				// Update metadata
				const metaFilename = filename.replace(/\.(jpg|jpeg)$/i, "_meta.json");
				const metaPath = path.join("./processed/metadata", metaFilename);

				try {
					const metaContent = await fs.readFile(metaPath, "utf-8");
					const metadata = JSON.parse(metaContent);
					metadata.noBackgroundFile = outputFilename;
					metadata.backgroundRemovalTime = processingTime;
					metadata.backgroundRemovedAt = new Date().toISOString();
					await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
					console.log("✅ Metadata updated");
				} catch (metaError) {
					console.warn("⚠️  Could not update metadata:", metaError.message);
				}

				results.push({
					filename,
					success: true,
					outputFilename,
					outputPath,
					processingTime,
					outputSize: outputStats.size,
				});

				console.log(`✅ [${i + 1}/${filesToProcess.length}] Completed: ${filename}`);
			} catch (error) {
				console.error(`❌ [${i + 1}/${filesToProcess.length}] Failed: ${filename}`);
				console.error("   Error:", error.message);
				results.push({
					filename,
					success: false,
					error: error.message,
				});
			}
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log("\n✅ ========== BACKGROUND REMOVAL COMPLETE ==========");
		console.log(`📊 Summary:`);
		console.log(`   Total: ${filesToProcess.length}`);
		console.log(`   Successful: ${successful}`);
		console.log(`   Failed: ${failed}`);
		console.log("===================================================\n");

		res.json({
			success: true,
			totalFiles: filesToProcess.length,
			processed: successful,
			failed,
			results,
		});
	} catch (error) {
		console.error("\n❌ ========== BACKGROUND REMOVAL ERROR ==========");
		console.error("Error:", error.message);
		console.error("Stack:", error.stack);
		console.error("=================================================\n");

		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Get list of images with background removed
app.get("/no-background-images", async (req, res) => {
	try {
		const files = await fs.readdir("./processed/no-background");
		const imageFiles = files.filter((f) => f.endsWith(".png"));

		const images = [];

		for (const file of imageFiles) {
			try {
				const filePath = path.join("./processed/no-background", file);
				const stats = await fs.stat(filePath);

				// Try to get metadata
				const originalFilename = file.replace("_no_bg.png", "_meta.json");
				const metaPath = path.join("./processed/metadata", originalFilename);

				let metadata = null;
				try {
					const metaContent = await fs.readFile(metaPath, "utf-8");
					metadata = JSON.parse(metaContent);
				} catch (metaError) {
					// Metadata not found, continue without it
				}

				images.push({
					filename: file,
					size: stats.size,
					sizeFormatted: `${(stats.size / 1024).toFixed(1)} KB`,
					createdAt: stats.mtime,
					metadata,
				});
			} catch (err) {
				console.log(`Error reading file ${file}:`, err.message);
			}
		}

		images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

		res.json({
			success: true,
			totalImages: images.length,
			images,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// ========================================
// COMFYUI ENDPOINTS (Step 5)
// ========================================

// Check ComfyUI health
app.get("/check-comfy", async (req, res) => {
	try {
		const isHealthy = await checkComfyHealth();
		res.json({
			comfyStatus: isHealthy ? "Connected" : "Not responding",
			url: "http://124.123.18.19:8188",
		});
	} catch (err) {
		res.json({
			comfyStatus: "Connection failed",
			error: err.message,
		});
	}
});

// Get available models
app.get("/comfy-models", async (req, res) => {
	try {
		const models = await getAvailableModels();
		res.json({
			success: true,
			models,
			default: "v1-5-pruned-emaonly.ckpt",
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Simple text-to-image generation
app.post("/generate-image", async (req, res) => {
	console.log("\n🎨 ========== STARTING TEXT-TO-IMAGE GENERATION ==========");
	try {
		const { prompt, negative_prompt = "blurry, low quality, distorted", seed = -1, count = 1 } = req.body;

		if (!prompt) {
			return res.status(400).json({
				success: false,
				error: "Prompt is required",
			});
		}

		console.log(`📝 Prompt: ${prompt}`);
		console.log(`🚫 Negative: ${negative_prompt}`);
		console.log(`🎲 Seed: ${seed}`);
		console.log(`🔢 Count: ${count}`);

		// Check ComfyUI health
		const isHealthy = await checkComfyHealth();
		if (!isHealthy) {
			return res.status(503).json({
				success: false,
				error: "ComfyUI is not running. Please start it at http://124.123.18.19:8188",
			});
		}

		const results = [];

		for (let i = 0; i < count; i++) {
			console.log(`\n🎨 [${i + 1}/${count}] Generating image...`);

			// Create workflow
			const currentSeed = seed === -1 ? Math.floor(Math.random() * 1000000) : seed + i;
			const workflow = createTextToImageWorkflow(prompt, negative_prompt, currentSeed);

			// Queue the prompt
			const queueResult = await queuePrompt(workflow);
			console.log(`✅ Queued with prompt_id: ${queueResult.prompt_id}`);

			// Wait for completion
			console.log("⏳ Waiting for generation...");
			const completion = await waitForCompletion(queueResult.prompt_id);

			if (!completion.success) {
				console.error(`❌ Generation ${i + 1} failed:`, completion.error);
				results.push({
					index: i + 1,
					success: false,
					error: completion.error,
				});
				continue;
			}

			// Get output filename from ComfyUI response
			const outputs = completion.status.outputs;
			const outputNode = outputs["9"]; // SaveImage node
			if (!outputNode || !outputNode.images || outputNode.images.length === 0) {
				console.error("❌ No output image found");
				results.push({
					index: i + 1,
					success: false,
					error: "No output image generated",
				});
				continue;
			}

			const outputFilename = outputNode.images[0].filename;
			console.log(`📥 Downloading: ${outputFilename}`);

			// Download the generated image
			const localPath = await downloadComfyOutput(outputFilename, "./processed/generated");
			console.log(`✅ Saved to: ${localPath}`);

			// Get file stats
			const stats = await fs.stat(localPath);

			results.push({
				index: i + 1,
				success: true,
				filename: path.basename(localPath),
				path: localPath,
				size: stats.size,
				seed: currentSeed,
				prompt,
			});
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log("\n✅ ========== GENERATION COMPLETE ==========");
		console.log(`📊 Summary:`);
		console.log(`   Total: ${count}`);
		console.log(`   Successful: ${successful}`);
		console.log(`   Failed: ${failed}`);
		console.log("==========================================\n");

		res.json({
			success: true,
			totalRequested: count,
			generated: successful,
			failed,
			results,
		});
	} catch (error) {
		console.error("\n❌ ========== GENERATION ERROR ==========");
		console.error("Error:", error.message);
		console.error("Stack:", error.stack);
		console.error("=========================================\n");

		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Generate product variations from uploaded/processed images
app.post("/generate-variations", async (req, res) => {
	console.log("\n🎨 ========== STARTING PRODUCT VARIATION GENERATION ==========");
	try {
		const {
			filename,
			prompt,
			negative_prompt = "blurry, low quality, distorted, ugly",
			strength = 0.75,
			count = 3,
			style = "studio",
		} = req.body;

		if (!filename) {
			return res.status(400).json({
				success: false,
				error: "Filename is required",
			});
		}

		console.log(`📸 Source image: ${filename}`);
		console.log(`📝 Prompt: ${prompt || "auto-generated"}`);
		console.log(`💪 Strength: ${strength}`);
		console.log(`🎨 Style: ${style}`);
		console.log(`🔢 Count: ${count}`);

		// Check ComfyUI health
		const isHealthy = await checkComfyHealth();
		if (!isHealthy) {
			return res.status(503).json({
				success: false,
				error: "ComfyUI is not running",
			});
		}

		// Find the source image (check multiple directories)
		let sourcePath;
		const possiblePaths = [
			path.join("./processed/no-background", filename),
			path.join("./processed/resized", filename),
			path.join("./processed/originals", filename),
			path.join("./uploads", filename),
		];

		for (const testPath of possiblePaths) {
			try {
				await fs.access(testPath);
				sourcePath = testPath;
				console.log(`✅ Found source at: ${sourcePath}`);
				break;
			} catch (error) {
				// Continue to next path
			}
		}

		if (!sourcePath) {
			return res.status(404).json({
				success: false,
				error: "Source image not found in any processed directory",
			});
		}

		// Upload image to ComfyUI
		console.log("📤 Uploading to ComfyUI...");
		const uploadedFilename = await uploadImageToComfy(sourcePath);
		console.log(`✅ Uploaded as: ${uploadedFilename}`);

		// Generate prompt if not provided
		let finalPrompt = prompt;
		if (!finalPrompt) {
			const fashionPrompts = getFashionPrompts("clothing");
			finalPrompt = fashionPrompts[style] || fashionPrompts.studio;
			console.log(`🤖 Auto-generated prompt: ${finalPrompt}`);
		}

		const results = [];

		for (let i = 0; i < count; i++) {
			console.log(`\n🎨 [${i + 1}/${count}] Generating variation...`);

			// Create workflow
			const currentSeed = Math.floor(Math.random() * 1000000);
			const workflow = createImg2ImgWorkflow(uploadedFilename, finalPrompt, negative_prompt, strength, currentSeed);

			// Queue the prompt
			const queueResult = await queuePrompt(workflow);
			console.log(`✅ Queued with prompt_id: ${queueResult.prompt_id}`);

			// Wait for completion
			console.log("⏳ Waiting for generation...");
			const completion = await waitForCompletion(queueResult.prompt_id);

			if (!completion.success) {
				console.error(`❌ Variation ${i + 1} failed:`, completion.error);
				results.push({
					index: i + 1,
					success: false,
					error: completion.error,
				});
				continue;
			}

			// Get output filename
			const outputs = completion.status.outputs;
			const outputNode = outputs["9"]; // SaveImage node
			if (!outputNode || !outputNode.images || outputNode.images.length === 0) {
				console.error("❌ No output image found");
				results.push({
					index: i + 1,
					success: false,
					error: "No output image generated",
				});
				continue;
			}

			const outputFilename = outputNode.images[0].filename;
			console.log(`📥 Downloading: ${outputFilename}`);

			// Download the generated image
			const localPath = await downloadComfyOutput(outputFilename, "./processed/generated");
			console.log(`✅ Saved to: ${localPath}`);

			// Get file stats
			const stats = await fs.stat(localPath);

			results.push({
				index: i + 1,
				success: true,
				filename: path.basename(localPath),
				path: localPath,
				size: stats.size,
				seed: currentSeed,
				originalImage: filename,
			});
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log("\n✅ ========== VARIATION GENERATION COMPLETE ==========");
		console.log(`📊 Summary:`);
		console.log(`   Source: ${filename}`);
		console.log(`   Total: ${count}`);
		console.log(`   Successful: ${successful}`);
		console.log(`   Failed: ${failed}`);
		console.log("====================================================\n");

		res.json({
			success: true,
			sourceImage: filename,
			totalRequested: count,
			generated: successful,
			failed,
			prompt: finalPrompt,
			strength,
			results,
		});
	} catch (error) {
		console.error("\n❌ ========== VARIATION ERROR ==========");
		console.error("Error:", error.message);
		console.error("Stack:", error.stack);
		console.error("========================================\n");

		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Get list of generated images
app.get("/generated-images", async (req, res) => {
	try {
		const files = await fs.readdir("./processed/generated");
		const imageFiles = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f));

		const images = [];

		for (const file of imageFiles) {
			try {
				const filePath = path.join("./processed/generated", file);
				const stats = await fs.stat(filePath);

				images.push({
					filename: file,
					size: stats.size,
					sizeFormatted: `${(stats.size / 1024).toFixed(1)} KB`,
					createdAt: stats.mtime,
				});
			} catch (err) {
				console.log(`Error reading file ${file}:`, err.message);
			}
		}

		images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

		res.json({
			success: true,
			totalImages: images.length,
			images,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// Get fashion prompt templates
app.get("/fashion-prompts", (req, res) => {
	const { productType = "clothing" } = req.query;

	const prompts = getFashionPrompts(productType);

	res.json({
		success: true,
		productType,
		prompts,
		availableTypes: ["clothing", "shoes", "accessories"],
	});
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
});
