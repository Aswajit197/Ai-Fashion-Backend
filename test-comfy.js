// test-comfy.js
// Run with: node test-comfy.js

import fetch from "node-fetch";

const COMFY_URL = "http://124.123.18.19:8188";

async function testComfyUI() {
	console.log("🧪 Testing ComfyUI Connection...\n");

	// Test 1: Basic connectivity
	console.log("1️⃣ Testing basic connection...");
	try {
		const response = await fetch(`${COMFY_URL}/system_stats`);
		if (response.ok) {
			console.log("✅ ComfyUI is accessible");
			const data = await response.json();
			console.log("   System:", data.system);
		} else {
			console.log("❌ ComfyUI responded with error:", response.status);
			return;
		}
	} catch (error) {
		console.log("❌ Cannot connect to ComfyUI:", error.message);
		return;
	}

	// Test 2: Get available models
	console.log("\n2️⃣ Checking available models...");
	try {
		const response = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
		const data = await response.json();
		const models = data.CheckpointLoaderSimple.input.required.ckpt_name[0];
		console.log("✅ Found models:");
		models.forEach((model, i) => {
			console.log(`   ${i + 1}. ${model}`);
		});

		// Find SD1.5 model
		const sd15Model = models.find((m) => m.includes("v1-5") || m.includes("SD1.5"));
		if (sd15Model) {
			console.log(`\n✅ SD1.5 model found: ${sd15Model}`);
		} else {
			console.log("\n⚠️  No SD1.5 model found, using first available:", models[0]);
		}
	} catch (error) {
		console.log("❌ Error getting models:", error.message);
		return;
	}

	// Test 3: Check queue
	console.log("\n3️⃣ Checking queue status...");
	try {
		const response = await fetch(`${COMFY_URL}/queue`);
		const data = await response.json();
		console.log("✅ Queue status:");
		console.log("   Running:", data.queue_running?.length || 0);
		console.log("   Pending:", data.queue_pending?.length || 0);
	} catch (error) {
		console.log("❌ Error checking queue:", error.message);
	}

	// Test 4: Try a simple prompt
	console.log("\n4️⃣ Testing simple prompt...");
	try {
		// Get the correct model name
		const modelsResponse = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
		const modelsData = await modelsResponse.json();
		const models = modelsData.CheckpointLoaderSimple.input.required.ckpt_name[0];
		const modelName = models.find((m) => m.includes("v1-5") || m.includes("SD1.5")) || models[0];

		console.log(`   Using model: ${modelName}`);

		const workflow = {
			3: {
				inputs: {
					seed: 123456,
					steps: 10,
					cfg: 7,
					sampler_name: "euler",
					scheduler: "normal",
					denoise: 1,
					model: ["4", 0],
					positive: ["6", 0],
					negative: ["7", 0],
					latent_image: ["5", 0],
				},
				class_type: "KSampler",
			},
			4: {
				inputs: {
					ckpt_name: modelName,
				},
				class_type: "CheckpointLoaderSimple",
			},
			5: {
				inputs: {
					width: 512,
					height: 512,
					batch_size: 1,
				},
				class_type: "EmptyLatentImage",
			},
			6: {
				inputs: {
					text: "a simple red circle on white background",
					clip: ["4", 1],
				},
				class_type: "CLIPTextEncode",
			},
			7: {
				inputs: {
					text: "blurry",
					clip: ["4", 1],
				},
				class_type: "CLIPTextEncode",
			},
			8: {
				inputs: {
					samples: ["3", 0],
					vae: ["4", 2],
				},
				class_type: "VAEDecode",
			},
			9: {
				inputs: {
					filename_prefix: "test",
					images: ["8", 0],
				},
				class_type: "SaveImage",
			},
		};

		console.log("   Sending prompt to ComfyUI...");
		const response = await fetch(`${COMFY_URL}/prompt`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ prompt: workflow }),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.log("❌ Failed to queue prompt:", response.status);
			console.log("   Error:", errorText);
			return;
		}

		const result = await response.json();
		console.log("✅ Prompt queued successfully!");
		console.log("   Prompt ID:", result.prompt_id);

		// Wait a moment and check if it started processing
		await new Promise((resolve) => setTimeout(resolve, 2000));

		const historyResponse = await fetch(`${COMFY_URL}/history/${result.prompt_id}`);
		const historyData = await historyResponse.json();

		if (historyData[result.prompt_id]) {
			console.log("✅ Prompt is being processed!");
			console.log("\n🎉 All tests passed! Your ComfyUI setup is working correctly.");
		} else {
			console.log("⏳ Prompt queued but not started yet (this is normal)");
			console.log("\n✅ Connection tests passed!");
		}
	} catch (error) {
		console.log("❌ Error testing prompt:", error.message);
		console.log("   Stack:", error.stack);
	}
}

testComfyUI().catch(console.error);
