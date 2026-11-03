import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("❌ ERROR: GEMINI_API_KEY is missing in your .env file!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

// Try 'gemini-1.5-flash' or 'gemini-2.0-flash' if 'gemini-3.6-flash' throws a model error
const MODEL_NAME = "gemini-3.6-flash"; 

async function runTest() {
  console.log(`📡 Initializing test with model [${MODEL_NAME}]...`);
  
  try {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });
    const prompt = "Kamusta ka? Magpakilala ka nang maikli sa Taglish.";

    console.log("⏳ Sending request to Gemini API...");
    
    const result = await model.generateContentStream(prompt);

    process.stdout.write("🤖 Gemini Output: ");
    for await (const chunk of result.stream) {
      process.stdout.write(chunk.text());
    }

    console.log("\n\n✅ SUCCESS: Gemini API key and stream connection are fully working!");
  } catch (error) {
    console.error("\n❌ API REQUEST FAILED!");
    console.error("Detailed Error:", error.message || error);
  }
}

runTest();