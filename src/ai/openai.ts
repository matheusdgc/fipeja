import OpenAI from 'openai';
import { config } from '../config.js';
import { VEHICLE_QUERY_PROMPT, PDF_EXTRACTION_PROMPT } from './prompts.js';

const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export interface VehicleInterpretation {
  brand: string | null;
  model: string | null;
  year: number | null;
  vehicleType: 'carros' | 'motos' | 'caminhoes';
  fipeCode: string | null;
  isVehicleQuery: boolean;
}

export interface VehicleFromPdf {
  brand: string;
  model: string;
  year: number | null;
  vehicleType: 'carros' | 'motos' | 'caminhoes';
  fipeCode: string | null;
}

/**
 * Interpreta uma mensagem de texto do usuário e extrai informações do veículo.
 */
export async function interpretVehicleQuery(userMessage: string): Promise<VehicleInterpretation> {
  const response = await client.chat.completions.create({
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: VEHICLE_QUERY_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('OpenAI retornou resposta vazia');
  }

  return JSON.parse(content) as VehicleInterpretation;
}

/**
 * Extrai lista de veículos a partir do texto de um PDF.
 */
export async function extractVehiclesFromPdf(pdfText: string): Promise<VehicleFromPdf[]> {
  const response = await client.chat.completions.create({
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: PDF_EXTRACTION_PROMPT },
      { role: 'user', content: pdfText },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('OpenAI retornou resposta vazia');
  }

  const parsed = JSON.parse(content);
  return parsed.vehicles || [];
}
