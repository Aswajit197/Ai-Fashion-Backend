// utils/comfyProcessor.js
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const COMFY_URL = "http://124.123.18.19:8188";

/**
 * Queue a prompt to ComfyUI
 */
export async function queuePrompt(workflow) {
	try {
		const response = await fetch(`${COMFY_URL}/prompt`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ prompt: workflow }),
		});

		if (!response.ok) {
			throw new Error(`ComfyUI error: ${response.status}`);
		}

		const result = await response.json();
		return result;
	} catch (error) {
		throw new Error(`Failed to queue prompt: ${error.message}`);
	}
}

/**
 * Check if ComfyUI is running and healthy
 */
export async function checkComfyHealth() {
	try {
		const response = await fetch(`${COMFY_URL}/system_stats`, {
			method: "GET",
		});
		return response.ok;
	} catch (error) {
		return false;
	}
}

/**
 * Get the status of a prompt execution
 */
export async function getPromptStatus(promptId) {
	try {
		const response = await fetch(`${COMFY_URL}/history/${promptId}`);
		if (!response.ok) {
			return { status: "unknown" };
		}
		const data = await response.json();
		return data[promptId] || { status: "not_found" };
	} catch (error) {
		return { status: "error", error: error.message };
	}
}

/**
 * Wait for prompt to complete and return the output
 */
export async function waitForCompletion(promptId, maxWaitTime = 120000) {
	const startTime = Date.now();
	const pollInterval = 2000; // Check every 2 seconds

	while (Date.now() - startTime < maxWaitTime) {
		const status = await getPromptStatus(promptId);

		if (status.status?.completed || status.outputs) {
			return { success: true, status };
		}

		if (status.status?.status_str === "error") {
			return { success: false, error: "Generation failed", status };
		}

		await new Promise((resolve) => setTimeout(resolve, pollInterval));
	}

	return { success: false, error: "Timeout waiting for generation" };
}

/**
 * Upload image to ComfyUI for img2img workflows
 */
export async function uploadImageToComfy(imagePath) {
	try {
		const FormData = (await import("form-data")).default;
		const formData = new FormData();

		const imageBuffer = await fs.readFile(imagePath);
		const filename = path.basename(imagePath);

		formData.append("image", imageBuffer, {
			filename: filename,
			contentType: "image/jpeg",
		});

		// Upload to ComfyUI's input directory
		const response = await fetch(`${COMFY_URL}/upload/image`, {
			method: "POST",
			body: formData,
			headers: formData.getHeaders(),
		});

		if (!response.ok) {
			throw new Error(`Upload failed: ${response.status}`);
		}

		const result = await response.json();
		return result.name; // Returns the filename ComfyUI saved it as
	} catch (error) {
		throw new Error(`Failed to upload image: ${error.message}`);
	}
}

/**
 * Download generated image from ComfyUI
 */
export async function downloadComfyOutput(filename, outputDir) {
	try {
		const response = await fetch(`${COMFY_URL}/view?filename=${filename}&type=output&subfolder=`);

		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		}

		const buffer = await response.arrayBuffer();
		const outputPath = path.join(outputDir, filename);

		await fs.writeFile(outputPath, Buffer.from(buffer));
		return outputPath;
	} catch (error) {
		throw new Error(`Failed to download output: ${error.message}`);
	}
}

/**
 * Create a simple text-to-image workflow
 */
export function createTextToImageWorkflow(prompt, negativePrompt = "", seed = -1) {
	return {
		3: {
			inputs: {
				seed: seed,
				steps: 20,
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
				ckpt_name: "v1-5-pruned-emaonly.ckpt",
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
				text: prompt,
				clip: ["4", 1],
			},
			class_type: "CLIPTextEncode",
		},
		7: {
			inputs: {
				text: negativePrompt,
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
				filename_prefix: "ComfyUI",
				images: ["8", 0],
			},
			class_type: "SaveImage",
		},
	};
}

/**
 * Create an image-to-image workflow for product variations
 */
export function createImg2ImgWorkflow(uploadedFilename, prompt, negativePrompt = "", strength = 0.75, seed = -1) {
	return {
		1: {
			inputs: {
				image: uploadedFilename,
				upload: "image",
			},
			class_type: "LoadImage",
		},
		2: {
			inputs: {
				pixels: ["1", 0],
				vae: ["4", 2],
			},
			class_type: "VAEEncode",
		},
		3: {
			inputs: {
				seed: seed,
				steps: 25,
				cfg: 7.5,
				sampler_name: "euler_ancestral",
				scheduler: "normal",
				denoise: strength,
				model: ["4", 0],
				positive: ["6", 0],
				negative: ["7", 0],
				latent_image: ["2", 0],
			},
			class_type: "KSampler",
		},
		4: {
			inputs: {
				ckpt_name: "v1-5-pruned-emaonly.ckpt",
			},
			class_type: "CheckpointLoaderSimple",
		},
		6: {
			inputs: {
				text: prompt,
				clip: ["4", 1],
			},
			class_type: "CLIPTextEncode",
		},
		7: {
			inputs: {
				text: negativePrompt,
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
				filename_prefix: "variation",
				images: ["8", 0],
			},
			class_type: "SaveImage",
		},
	};
}

/**
 * Get list of available models in ComfyUI
 */
export async function getAvailableModels() {
	try {
		const response = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`);
		if (!response.ok) {
			throw new Error("Failed to fetch models");
		}
		const data = await response.json();
		return data.CheckpointLoaderSimple.input.required.ckpt_name[0];
	} catch (error) {
		return ["v1-5-pruned-emaonly.ckpt"]; // Default fallback
	}
}

/**
 * Generate fashion product variations with predefined prompts
 */
export function getFashionPrompts(productType = "clothing") {
	const prompts = {
		clothing: {
			studio: "professional product photography, clean white background, studio lighting, high quality",
			lifestyle: "lifestyle product photo, natural lighting, casual setting, aesthetic composition",
			elegant: "elegant fashion photography, luxury presentation, sophisticated lighting, premium quality",
		},
		shoes: {
			studio: "professional shoe photography, clean white background, dramatic lighting, high detail",
			lifestyle: "casual shoe photo, outdoor setting, natural light, lifestyle composition",
			elegant: "luxury shoe photography, premium presentation, elegant lighting, high-end quality",
		},
		accessories: {
			studio: "professional accessory photography, minimal background, studio setup, sharp focus",
			lifestyle: "lifestyle accessory shot, natural environment, soft lighting, aesthetic style",
			elegant: "luxury accessory photography, premium presentation, sophisticated composition",
		},
	};

	return prompts[productType] || prompts.clothing;
}

export default {
	queuePrompt,
	checkComfyHealth,
	getPromptStatus,
	waitForCompletion,
	uploadImageToComfy,
	downloadComfyOutput,
	createTextToImageWorkflow,
	createImg2ImgWorkflow,
	getAvailableModels,
	getFashionPrompts,
};
