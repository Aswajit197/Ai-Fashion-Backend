import express from "express";
import fetch from "node-fetch";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs/promises";

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Create uploads directory if it doesn't exist
const createUploadsDir = async () => {
	try {
		await fs.mkdir("./uploads", { recursive: true });
		console.log("✅ Uploads directory ready");
	} catch (error) {
		console.log("📁 Uploads directory already exists");
	}
};
createUploadsDir();

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
		fileSize: 10 * 1024 * 1024, // 10MB limit per file
		files: 10, // max 10 files at once
	},
	fileFilter: (req, file, cb) => {
		// Only allow image files
		if (file.mimetype.startsWith("image/")) {
			cb(null, true);
		} else {
			cb(new Error("Only image files are allowed!"), false);
		}
	},
});

// EXISTING ENDPOINTS (unchanged)
app.post("/send-to-n8n", async (req, res) => {
	try {
		console.log("Sending data to n8n:", req.body);

		const response = await fetch("http://localhost:5678/webhook/from-backend", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(req.body),
			timeout: 10000,
		});

		console.log("n8n response status:", response.status);
		console.log("n8n response headers:", Object.fromEntries(response.headers));

		const contentType = response.headers.get("content-type");
		let data;

		if (contentType && contentType.includes("application/json")) {
			data = await response.json();
		} else {
			data = await response.text();
		}

		console.log("n8n response data:", data);

		if (!response.ok) {
			throw new Error(`n8n responded with status: ${response.status}, data: ${JSON.stringify(data)}`);
		}

		res.json({
			success: true,
			message: "Data sent to n8n successfully",
			n8nResponse: data,
		});
	} catch (err) {
		console.error("Error sending to n8n:", err);
		res.status(500).json({
			success: false,
			error: err.message,
			details: "Check if n8n is running and the webhook URL is correct",
		});
	}
});

app.get("/test", (req, res) => {
	res.json({
		message: "Backend server is running!",
		timestamp: new Date().toISOString(),
		endpoints: [
			"GET  /test - Health check",
			"GET  /check-n8n - Test n8n connection",
			"POST /send-to-n8n - Send data to n8n",
			"POST /upload-images - Upload image files",
			"GET  /uploads - List uploaded files",
		],
	});
});

app.get("/check-n8n", async (req, res) => {
	try {
		const response = await fetch("http://localhost:5678/from-backend", {
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

// NEW FILE UPLOAD ENDPOINTS

// Main file upload endpoint
app.post("/upload-images", upload.array("images", 10), async (req, res) => {
	try {
		if (!req.files || req.files.length === 0) {
			return res.status(400).json({
				success: false,
				error: "No files uploaded",
			});
		}

		console.log(`📤 Received ${req.files.length} files for upload`);

		// Prepare file metadata for n8n
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

		console.log("📨 Sending file metadata to n8n...");

		// Send file info to n8n for processing
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
			} else {
				console.log(`❌ n8n responded with status: ${n8nResponse.status}`);
			}

			// Return success response regardless of n8n status
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

			// Still return success for file upload, just note n8n issue
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

// Get list of uploaded files
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

		// Sort by upload time (newest first)
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

// Delete uploaded file (utility endpoint)
app.delete("/uploads/:filename", async (req, res) => {
	try {
		const filename = req.params.filename;
		const filepath = path.join("./uploads", filename);

		await fs.unlink(filepath);
		console.log(`🗑️ Deleted file: ${filename}`);

		res.json({
			success: true,
			message: `File ${filename} deleted successfully`,
		});
	} catch (error) {
		if (error.code === "ENOENT") {
			res.status(404).json({
				success: false,
				error: "File not found",
			});
		} else {
			res.status(500).json({
				success: false,
				error: error.message,
			});
		}
	}
});

// Error handling middleware for multer
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
	console.log(`📊 API endpoints available:`);
	console.log(`   GET  /test - Health check`);
	console.log(`   GET  /check-n8n - Test n8n connection`);
	console.log(`   POST /send-to-n8n - Send data to n8n`);
	console.log(`   POST /upload-images - Upload image files`);
	console.log(`   GET  /uploads - List uploaded files`);
	console.log(`   DELETE /uploads/:filename - Delete specific file`);
	console.log(`📁 Upload directory: ./uploads`);
	console.log(`🔗 n8n webhook endpoint: /webhook/process-upload`);
});
