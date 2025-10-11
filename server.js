import cors from "cors";
import express from "express";
import fs from "fs/promises";
import multer from "multer";
import fetch from "node-fetch";
import path from "path";
import {
	checkComfyHealth,
	createImg2ImgWorkflow,
	createTextToImageWorkflow,
	downloadComfyOutput,
	getAvailableModels,
	getDefaultModel,
	getFashionPrompts,
	queuePrompt,
	uploadImageToComfy,
	waitForCompletion,
} from "./utils/comfyProcessor.js";
import { generateImageHash, getImageInfo, isImageCorrupted, processImage, saveMetadata } from "./utils/imageProcessor.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Create required directories
const createDirectories = async () => {
	const dirs = [
		"./uploads",
		"./processed/originals",
		"./processed/resized",
		"./processed/metadata",
		"./processed/no-background",
		"./processed/generated",
	];

	for (const dir of dirs) {
		try {
			await fs.mkdir(dir, { recursive: true });
		} catch (error) {
			// Directory already exists
		}
	}
	console.log("✅ All directories initialized");
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
// HEALTH CHECK ENDPOINTS
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

app.get("/system-status", async (req, res) => {
	try {
		// Check all services
		const [comfyHealthy, rembgHealthy] = await Promise.all([
			checkComfyHealth().catch(() => false),
			fetch("https://bhdv4f7q-5000.inc1.devtunnels.ms/health")
				.then((r) => r.ok)
				.catch(() => false),
		]);

		// Get queue info if ComfyUI is healthy
		let queueInfo = null;
		if (comfyHealthy) {
			try {
				const queueRes = await fetch("http://124.123.18.19:8188/queue");
				const queueData = await queueRes.json();
				queueInfo = {
					running: (queueData.queue_running || []).length,
					pending: (queueData.queue_pending || []).length,
				};
			} catch (e) {
				// Queue info not critical
			}
		}

		// Get directory stats
		const stats = await Promise.all([
			fs
				.readdir("./uploads")
				.then((f) => f.length)
				.catch(() => 0),
			fs
				.readdir("./processed/originals")
				.then((f) => f.length)
				.catch(() => 0),
			fs
				.readdir("./processed/resized")
				.then((f) => f.length)
				.catch(() => 0),
			fs
				.readdir("./processed/no-background")
				.then((f) => f.length)
				.catch(() => 0),
			fs
				.readdir("./processed/generated")
				.then((f) => f.length)
				.catch(() => 0),
		]);

		res.json({
			success: true,
			timestamp: new Date().toISOString(),
			services: {
				backend: {
					status: "running",
					url: "http://localhost:3000",
				},
				comfyui: {
					status: comfyHealthy ? "connected" : "disconnected",
					url: "http://124.123.18.19:8188",
					queue: queueInfo,
				},
				rembg: {
					status: rembgHealthy ? "connected" : "disconnected",
					url: "https://bhdv4f7q-5000.inc1.devtunnels.ms",
				},
				n8n: {
					status: "unknown",
					url: "http://124.123.18.19:5678",
					note: "Use /check-n8n to verify",
				},
			},
			storage: {
				uploads: stats[0],
				originals: stats[1],
				resized: stats[2],
				noBackground: stats[3],
				generated: stats[4],
				total: stats.reduce((a, b) => a + b, 0),
			},
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

// ========================================
// UPLOAD ENDPOINTS
// ========================================

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

		// Try to notify n8n
		try {
			const n8nResponse = await fetch("http://124.123.18.19:5678/webhook/process-upload", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(uploadData),
			});

			let n8nSuccess = n8nResponse.ok;

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
				message: `Successfully uploaded ${req.files.length} files`,
			});
		} catch (n8nError) {
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
				message: `Files uploaded successfully, but n8n processing failed`,
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
// IMAGE PROCESSING ENDPOINTS
// ========================================

app.post("/process-images", async (req, res) => {
	console.log("\n🚀 ========== STARTING IMAGE PROCESSING ==========");
	try {
		const { uploadId, filenames } = req.body;

		// Get files to process
		let filesToProcess;
		if (filenames && Array.isArray(filenames)) {
			filesToProcess = filenames;
		} else {
			filesToProcess = await fs.readdir("./uploads");
		}

		const results = [];
		const hashes = new Set();
		const duplicates = [];

		for (let i = 0; i < filesToProcess.length; i++) {
			const filename = filesToProcess[i];
			console.log(`\n📸 [${i + 1}/${filesToProcess.length}] Processing: ${filename}`);

			try {
				const inputPath = path.join("./uploads", filename);
				const originalPath = path.join("./processed/originals", filename);
				const processedFilename = filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_processed.jpg");
				const processedPath = path.join("./processed/resized", processedFilename);
				const metadataPath = path.join("./processed/metadata", filename.replace(/\.(jpg|jpeg|png|webp|gif)$/i, "_meta.json"));

				// Check if file exists
				try {
					await fs.access(inputPath);
				} catch (error) {
					results.push({ filename, success: false, error: "Input file not found" });
					continue;
				}

				// Check if corrupted
				const corrupted = await isImageCorrupted(inputPath);
				if (corrupted) {
					results.push({ filename, success: false, error: "Image file is corrupted" });
					continue;
				}

				// Generate hash
				const hash = await generateImageHash(inputPath);
				if (hashes.has(hash)) {
					duplicates.push(filename);
					results.push({ filename, success: false, error: "Duplicate image detected", hash });
					continue;
				}
				hashes.add(hash);

				// Copy original
				await fs.copyFile(inputPath, originalPath);

				// Process image
				const processResult = await processImage(inputPath, processedPath);
				if (!processResult.success) {
					results.push({ filename, success: false, error: processResult.error });
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

				console.log(`✅ [${i + 1}/${filesToProcess.length}] Successfully processed`);
			} catch (error) {
				console.error(`❌ Error processing ${filename}:`, error.message);
				results.push({ filename, success: false, error: error.message });
			}
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log(`\n✅ Processing complete: ${successful} successful, ${failed} failed\n`);

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
		console.error("\n❌ Processing error:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

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

// ========================================
// BACKGROUND REMOVAL ENDPOINTS
// ========================================

app.post("/remove-background", async (req, res) => {
	console.log("\n🎨 ========== STARTING BACKGROUND REMOVAL ==========");
	try {
		const { filenames } = req.body;

		let filesToProcess;
		if (filenames && Array.isArray(filenames)) {
			filesToProcess = filenames;
		} else {
			const resizedFiles = await fs.readdir("./processed/resized");
			filesToProcess = resizedFiles.filter((f) => f.endsWith(".jpg") || f.endsWith(".jpeg") || f.endsWith(".png"));
		}

		if (filesToProcess.length === 0) {
			return res.json({
				success: false,
				error: "No images found to process",
			});
		}

		const results = [];
		const FormData = (await import("form-data")).default;

		for (let i = 0; i < filesToProcess.length; i++) {
			const filename = filesToProcess[i];
			console.log(`\n🎨 [${i + 1}/${filesToProcess.length}] Removing background: ${filename}`);

			try {
				const inputPath = path.join("./processed/resized", filename);
				const outputFilename = filename.replace(/\.(jpg|jpeg)$/i, "_no_bg.png");
				const outputPath = path.join("./processed/no-background", outputFilename);

				// Check input file
				await fs.access(inputPath);

				// Check rembg service
				const healthCheck = await fetch("https://bhdv4f7q-5000.inc1.devtunnels.ms/health");
				if (!healthCheck.ok) {
					results.push({ filename, success: false, error: "rembg service not available" });
					continue;
				}

				// Prepare and send
				const formData = new FormData();
				const fileStream = await fs.readFile(inputPath);
				formData.append("image", fileStream, {
					filename: filename,
					contentType: "image/jpeg",
				});

				const startTime = Date.now();
				const response = await fetch("https://bhdv4f7q-5000.inc1.devtunnels.ms/remove-background", {
					method: "POST",
					body: formData,
					headers: formData.getHeaders(),
				});

				if (!response.ok) {
					results.push({ filename, success: false, error: `Service error: ${response.status}` });
					continue;
				}

				const buffer = await response.arrayBuffer();
				await fs.writeFile(outputPath, Buffer.from(buffer));

				const processingTime = Date.now() - startTime;
				const outputStats = await fs.stat(outputPath);

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
				} catch (metaError) {
					// Metadata update not critical
				}

				results.push({
					filename,
					success: true,
					outputFilename,
					outputPath,
					processingTime,
					outputSize: outputStats.size,
				});

				console.log(`✅ [${i + 1}/${filesToProcess.length}] Completed`);
			} catch (error) {
				console.error(`❌ Failed: ${filename}`, error.message);
				results.push({ filename, success: false, error: error.message });
			}
		}

		const successful = results.filter((r) => r.success).length;
		const failed = results.filter((r) => !r.success).length;

		console.log(`\n✅ Background removal complete: ${successful} successful, ${failed} failed\n`);

		res.json({
			success: true,
			totalFiles: filesToProcess.length,
			processed: successful,
			failed,
			results,
		});
	} catch (error) {
		console.error("\n❌ Background removal error:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.get("/no-background-images", async (req, res) => {
	try {
		const files = await fs.readdir("./processed/no-background");
		const imageFiles = files.filter((f) => f.endsWith(".png"));

		const images = [];

		for (const file of imageFiles) {
			try {
				const filePath = path.join("./processed/no-background", file);
				const stats = await fs.stat(filePath);

				const originalFilename = file.replace("_no_bg.png", "_meta.json");
				const metaPath = path.join("./processed/metadata", originalFilename);

				let metadata = null;
				try {
					const metaContent = await fs.readFile(metaPath, "utf-8");
					metadata = JSON.parse(metaContent);
				} catch (metaError) {
					// Metadata not found
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
// COMFYUI ENDPOINTS
// ========================================

app.get("/comfy-models", async (req, res) => {
	try {
		const models = await getAvailableModels();
		const defaultModel = await getDefaultModel();
		res.json({
			success: true,
			models,
			default: defaultModel,
			recommended: defaultModel,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.get("/comfy-queue", async (req, res) => {
	try {
		const response = await fetch("http://124.123.18.19:8188/queue");
		const data = await response.json();

		const queueRunning = data.queue_running || [];
		const queuePending = data.queue_pending || [];

		res.json({
			success: true,
			running: queueRunning.length,
			pending: queuePending.length,
			totalInQueue: queueRunning.length + queuePending.length,
			details: {
				running: queueRunning,
				pending: queuePending,
			},
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.get("/comfy-stats", async (req, res) => {
	try {
		const response = await fetch("http://124.123.18.19:8188/system_stats");
		const data = await response.json();

		res.json({
			success: true,
			system: data.system,
			devices: data.devices,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.post("/comfy-clear-queue", async (req, res) => {
	try {
		await fetch("http://124.123.18.19:8188/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clear: true }),
		});

		res.json({
			success: true,
			message: "Queue cleared successfully",
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

app.get("/comfy-history", async (req, res) => {
	try {
		const { limit = 10 } = req.query;
		const response = await fetch("http://124.123.18.19:8188/history");
		const data = await response.json();

		const historyArray = Object.entries(data)
			.map(([id, info]) => ({
				id,
				...info,
			}))
			.slice(0, parseInt(limit));

		res.json({
			success: true,
			count: historyArray.length,
			history: historyArray,
		});
	} catch (error) {
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

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
		console.log(`🔢 Count: ${count}`);

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

			const currentSeed = seed === -1 ? Math.floor(Math.random() * 1000000) : seed + i;
			const workflow = await createTextToImageWorkflow(prompt, negative_prompt, currentSeed);

			const queueResult = await queuePrompt(workflow);
			console.log(`✅ Queued with prompt_id: ${queueResult.prompt_id}`);

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

			const outputs = completion.status.outputs;
			const outputNode = outputs["9"];
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

			const localPath = await downloadComfyOutput(outputFilename, "./processed/generated");
			console.log(`✅ Saved to: ${localPath}`);

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

		console.log(`\n✅ Generation complete: ${successful} successful, ${failed} failed\n`);

		res.json({
			success: true,
			totalRequested: count,
			generated: successful,
			failed,
			results,
		});
	} catch (error) {
		console.error("\n❌ Generation error:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

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
		console.log(`🎨 Style: ${style}`);
		console.log(`🔢 Count: ${count}`);

		const isHealthy = await checkComfyHealth();
		if (!isHealthy) {
			return res.status(503).json({
				success: false,
				error: "ComfyUI is not running",
			});
		}

		// Find source image
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
				// Continue
			}
		}

		if (!sourcePath) {
			return res.status(404).json({
				success: false,
				error: "Source image not found in any processed directory",
			});
		}

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

			const currentSeed = Math.floor(Math.random() * 1000000);
			const workflow = await createImg2ImgWorkflow(uploadedFilename, finalPrompt, negative_prompt, strength, currentSeed);

			const queueResult = await queuePrompt(workflow);
			console.log(`✅ Queued with prompt_id: ${queueResult.prompt_id}`);

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

			const outputs = completion.status.outputs;
			const outputNode = outputs["9"];
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

			const localPath = await downloadComfyOutput(outputFilename, "./processed/generated");
			console.log(`✅ Saved to: ${localPath}`);

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

		console.log(`\n✅ Variation generation complete: ${successful} successful, ${failed} failed\n`);

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
		console.error("\n❌ Variation error:", error.message);
		res.status(500).json({
			success: false,
			error: error.message,
		});
	}
});

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

// ========================================
// ERROR HANDLING
// ========================================

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
	console.log(`📊 System status: http://localhost:${PORT}/system-status`);
	console.log(`🎨 ComfyUI: http://124.123.18.19:8188`);
	console.log(`🖼️  rembg: https://bhdv4f7q-5000.inc1.devtunnels.ms`);
});
