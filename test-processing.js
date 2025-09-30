// backend/test-processing.js
// Simple test script to verify image processing

import fetch from "node-fetch";

const BASE_URL = "http://localhost:3000";

async function testProcessing() {
	console.log("🧪 Testing Image Processing System\n");

	// Test 1: Health Check
	console.log("1️⃣ Testing health check...");
	try {
		const response = await fetch(`${BASE_URL}/test`);
		const data = await response.json();
		console.log("✅ Server is running");
		console.log(`   Features: ${data.features.join(", ")}\n`);
	} catch (error) {
		console.error("❌ Server not running:", error.message);
		return;
	}

	// Test 2: Check uploads
	console.log("2️⃣ Checking uploaded files...");
	try {
		const response = await fetch(`${BASE_URL}/uploads`);
		const data = await response.json();
		console.log(`✅ Found ${data.totalFiles} uploaded files`);

		if (data.totalFiles === 0) {
			console.log("⚠️  No files to process. Please upload some images first.\n");
			return;
		}
		console.log();
	} catch (error) {
		console.error("❌ Failed to check uploads:", error.message);
		return;
	}

	// Test 3: Process images
	console.log("3️⃣ Processing images...");
	try {
		const response = await fetch(`${BASE_URL}/process-images`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const data = await response.json();

		if (data.success) {
			console.log("✅ Processing complete!");
			console.log(`   Total files: ${data.totalFiles}`);
			console.log(`   Processed: ${data.processed}`);
			console.log(`   Failed: ${data.failed}`);
			console.log(`   Duplicates: ${data.duplicates}`);

			if (data.results && data.results.length > 0) {
				console.log("\n   Results:");
				data.results.forEach((result, index) => {
					if (result.success) {
						console.log(`   ${index + 1}. ✅ ${result.filename}`);
						console.log(
							`      Original: ${result.original.width}x${result.original.height} (${(result.original.fileSize / 1024).toFixed(
								0
							)}KB)`
						);
						console.log(
							`      Processed: ${result.processed.width}x${result.processed.height} (${(
								result.processed.fileSize / 1024
							).toFixed(0)}KB)`
						);
						console.log(`      Time: ${result.processingTime}ms`);
					} else {
						console.log(`   ${index + 1}. ❌ ${result.filename}: ${result.error}`);
					}
				});
			}
		} else {
			console.error("❌ Processing failed:", data.error);
		}
		console.log();
	} catch (error) {
		console.error("❌ Processing request failed:", error.message);
		return;
	}

	// Test 4: Check processed images
	console.log("4️⃣ Checking processed images...");
	try {
		const response = await fetch(`${BASE_URL}/processed-images`);
		const data = await response.json();

		console.log(`✅ Found ${data.totalProcessed} processed images`);

		if (data.images && data.images.length > 0) {
			console.log("\n   Processed files:");
			data.images.slice(0, 5).forEach((img, index) => {
				console.log(`   ${index + 1}. ${img.filename} - ${img.sizeFormatted}`);
			});

			if (data.images.length > 5) {
				console.log(`   ... and ${data.images.length - 5} more`);
			}
		}
		console.log();
	} catch (error) {
		console.error("❌ Failed to check processed images:", error.message);
	}

	console.log("✅ All tests completed!\n");
}

// Run tests
testProcessing().catch(console.error);
