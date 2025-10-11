// full-pipeline-test.js
// Complete end-to-end test of the fashion AI pipeline
// Run with: node full-pipeline-test.js

import fetch from "node-fetch";
import fs from "fs/promises";
import FormData from "form-data";
import path from "path";

const API_URL = "http://localhost:3000";
const COMFY_URL = "http://124.123.18.19:8188";

// Color codes for terminal output
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
};

function log(message, color = "reset") {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
	console.log("\n" + "=".repeat(60));
	log(title, "bright");
	console.log("=".repeat(60) + "\n");
}

async function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPipeline() {
	section("🚀 FASHION AI PIPELINE - COMPLETE TEST");

	let testResults = {
		services: {},
		generation: {},
		storage: {},
	};

	// ==========================================
	// STEP 1: Check All Services
	// ==========================================
	section("1️⃣ CHECKING SERVICES");

	try {
		log("Checking Backend...", "cyan");
		const backendResponse = await fetch(`${API_URL}/system-status`);
		if (backendResponse.ok) {
			log("✅ Backend is running", "green");
			const data = await backendResponse.json();
			testResults.services.backend = true;
			testResults.services.comfyui = data.services.comfyui.status === "connected";
			testResults.services.rembg = data.services.rembg.status === "connected";

			log(`   ComfyUI: ${data.services.comfyui.status}`, data.services.comfyui.status === "connected" ? "green" : "red");
			log(`   rembg: ${data.services.rembg.status}`, data.services.rembg.status === "connected" ? "green" : "red");

			console.log("\n📊 Storage Status:");
			console.log(`   Uploads: ${data.storage.uploads}`);
			console.log(`   Originals: ${data.storage.originals}`);
			console.log(`   Resized: ${data.storage.resized}`);
			console.log(`   No Background: ${data.storage.noBackground}`);
			console.log(`   Generated: ${data.storage.generated}`);
			console.log(`   Total: ${data.storage.total}`);
		} else {
			log("❌ Backend is not responding", "red");
			testResults.services.backend = false;
			return testResults;
		}
	} catch (error) {
		log(`❌ Error connecting to backend: ${error.message}`, "red");
		testResults.services.backend = false;
		return testResults;
	}

	if (!testResults.services.comfyui) {
		log("\n⚠️  ComfyUI is not connected. Skipping generation tests.", "yellow");
		return testResults;
	}

	// ==========================================
	// STEP 2: Text-to-Image Generation
	// ==========================================
	section("2️⃣ TESTING TEXT-TO-IMAGE GENERATION");

	const prompts = [
		{
			name: "Red T-Shirt",
			prompt: "professional product photography of a red t-shirt, white background, studio lighting, high quality",
			negative: "blurry, low quality, distorted, watermark",
		},
		{
			name: "Blue Jeans",
			prompt: "professional product photo of blue denim jeans, clean white background, studio setup",
			negative: "blurry, low quality, bad composition",
		},
	];

	testResults.generation.textToImage = [];

	for (const testCase of prompts) {
		log(`\n📝 Generating: ${testCase.name}`, "cyan");
		log(`   Prompt: ${testCase.prompt}`);

		try {
			const startTime = Date.now();

			const response = await fetch(`${API_URL}/generate-image`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: testCase.prompt,
					negative_prompt: testCase.negative,
					count: 1,
				}),
			});

			const data = await response.json();

			if (data.success && data.generated > 0) {
				const duration = ((Date.now() - startTime) / 1000).toFixed(1);
				log(`✅ Generated successfully in ${duration}s`, "green");
				log(`   Filename: ${data.results[0].filename}`);
				log(`   Size: ${(data.results[0].size / 1024).toFixed(1)} KB`);

				testResults.generation.textToImage.push({
					name: testCase.name,
					success: true,
					duration,
					filename: data.results[0].filename,
					size: data.results[0].size,
				});
			} else {
				log(`❌ Generation failed: ${data.error || "Unknown error"}`, "red");
				testResults.generation.textToImage.push({
					name: testCase.name,
					success: false,
					error: data.error,
				});
			}

			// Wait a bit between requests
			await sleep(2000);
		} catch (error) {
			log(`❌ Error: ${error.message}`, "red");
			testResults.generation.textToImage.push({
				name: testCase.name,
				success: false,
				error: error.message,
			});
		}
	}

	// ==========================================
	// STEP 3: Check Generated Images
	// ==========================================
	section("3️⃣ VERIFYING GENERATED IMAGES");

	try {
		const response = await fetch(`${API_URL}/generated-images`);
		const data = await response.json();

		if (data.success) {
			log(`✅ Found ${data.totalImages} generated images`, "green");
			testResults.storage.generatedImages = data.totalImages;

			if (data.images.length > 0) {
				console.log("\n📸 Recent generations:");
				data.images.slice(0, 5).forEach((img, i) => {
					console.log(`   ${i + 1}. ${img.filename}`);
					console.log(`      Size: ${img.sizeFormatted}`);
					console.log(`      Created: ${new Date(img.createdAt).toLocaleString()}`);
				});
			}
		}
	} catch (error) {
		log(`❌ Error checking generated images: ${error.message}`, "red");
	}

	// ==========================================
	// STEP 4: Test Queue Management
	// ==========================================
	section("4️⃣ TESTING QUEUE MANAGEMENT");

	try {
		log("Checking ComfyUI queue...", "cyan");
		const response = await fetch(`${API_URL}/comfy-queue`);
		const data = await response.json();

		if (data.success) {
			log("✅ Queue is accessible", "green");
			console.log(`   Running: ${data.running}`);
			console.log(`   Pending: ${data.pending}`);
			testResults.queue = {
				running: data.running,
				pending: data.pending,
			};
		}
	} catch (error) {
		log(`❌ Error checking queue: ${error.message}`, "red");
	}

	// ==========================================
	// STEP 5: Test Fashion Prompts
	// ==========================================
	section("5️⃣ TESTING FASHION PROMPT TEMPLATES");

	try {
		const response = await fetch(`${API_URL}/fashion-prompts?productType=clothing`);
		const data = await response.json();

		if (data.success) {
			log("✅ Fashion prompts loaded", "green");
			console.log("\n🎨 Available styles:");
			Object.entries(data.prompts).forEach(([style, prompt]) => {
				console.log(`\n   ${style}:`);
				console.log(`   "${prompt}"`);
			});
			testResults.fashionPrompts = true;
		}
	} catch (error) {
		log(`❌ Error loading fashion prompts: ${error.message}`, "red");
		testResults.fashionPrompts = false;
	}

	// ==========================================
	// STEP 6: Test Batch Generation
	// ==========================================
	section("6️⃣ TESTING BATCH GENERATION");

	log("Generating 3 variations of a product...", "cyan");

	try {
		const startTime = Date.now();

		const response = await fetch(`${API_URL}/generate-image`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "professional product photography of white sneakers, clean background",
				negative_prompt: "blurry, low quality",
				count: 3,
				seed: 42,
			}),
		});

		const data = await response.json();
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);

		if (data.success) {
			log(`✅ Generated ${data.generated} images in ${duration}s`, "green");
			log(`   Average: ${(duration / data.generated).toFixed(1)}s per image`);
			testResults.generation.batch = {
				success: true,
				count: data.generated,
				duration,
			};
		} else {
			log(`❌ Batch generation failed: ${data.error}`, "red");
			testResults.generation.batch = {
				success: false,
				error: data.error,
			};
		}
	} catch (error) {
		log(`❌ Error: ${error.message}`, "red");
		testResults.generation.batch = {
			success: false,
			error: error.message,
		};
	}

	// ==========================================
	// FINAL SUMMARY
	// ==========================================
	section("📊 TEST SUMMARY");

	const allServicesUp = testResults.services.backend && testResults.services.comfyui && testResults.services.rembg;

	const txt2imgSuccess = testResults.generation.textToImage.filter((t) => t.success).length;
	const txt2imgTotal = testResults.generation.textToImage.length;

	console.log("Services:");
	log(`  Backend: ${testResults.services.backend ? "✅" : "❌"}`, testResults.services.backend ? "green" : "red");
	log(`  ComfyUI: ${testResults.services.comfyui ? "✅" : "❌"}`, testResults.services.comfyui ? "green" : "red");
	log(`  rembg: ${testResults.services.rembg ? "✅" : "❌"}`, testResults.services.rembg ? "green" : "red");

	console.log("\nGeneration:");
	log(`  Text-to-Image: ${txt2imgSuccess}/${txt2imgTotal} passed`, txt2imgSuccess === txt2imgTotal ? "green" : "yellow");
	if (testResults.generation.batch) {
		log(
			`  Batch Generation: ${testResults.generation.batch.success ? "✅" : "❌"}`,
			testResults.generation.batch.success ? "green" : "red"
		);
	}

	console.log("\nStorage:");
	if (testResults.storage.generatedImages !== undefined) {
		log(`  Generated Images: ${testResults.storage.generatedImages}`, "cyan");
	}

	console.log("\n" + "=".repeat(60));

	if (allServicesUp && txt2imgSuccess === txt2imgTotal) {
		log("🎉 ALL TESTS PASSED! Your pipeline is ready for production.", "green");
	} else if (testResults.services.comfyui && txt2imgSuccess > 0) {
		log("⚠️  Some tests failed, but basic functionality works.", "yellow");
	} else {
		log("❌ Critical issues found. Please check the logs above.", "red");
	}

	console.log("=".repeat(60) + "\n");

	// Save detailed results to file
	try {
		await fs.writeFile("./test-results.json", JSON.stringify(testResults, null, 2));
		log("📄 Detailed results saved to: test-results.json", "cyan");
	} catch (error) {
		// Ignore file save errors
	}

	return testResults;
}

// Run the test
testPipeline().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
