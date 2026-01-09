
import { GoogleGenAI, Type } from "@google/genai";
import { ExtractionResult } from "../types";

const SHARED_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    processes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          foro: {
            type: Type.STRING,
            description: 'O nome da cidade ou foro, limpo (ex: Jaboticabal).',
          },
          processo: {
            type: Type.STRING,
            description: 'O número do processo formatado corretamente.',
          },
        },
        required: ["foro", "processo"],
      },
    },
  },
  required: ["processes"],
};

export const extractLegalData = async (text: string, searchList?: string): Promise<ExtractionResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const systemPrompt = searchList 
    ? `Você é um assistente jurídico especializado em filtragem de documentos de alta precisão.
       Busque EXCLUSIVAMENTE os seguintes números de processo no texto: ${searchList}.
       Para cada um encontrado, identifique o Foro correspondente.
       Regras:
       1. Só retorne processos que estejam na lista de busca.
       2. O "foro" deve ser o nome da cidade ou comarca limpo (ex: "Jaboticabal").
       3. O número do processo deve ser formatado conforme o padrão CNJ (ex: "1001821-85.2024.8.26.0291").`
    : `Você é um analista jurídico de IA. Extraia informações de todos os processos jurídicos encontrados no texto.
       Regras:
       1. Identifique o foro (cidade/comarca) e o número do processo.
       2. O "foro" deve ser extraído e limpo (ex: "Jaboticabal").
       3. O número do processo deve ser formatado sem espaços e com pontuação correta.
       4. Ignore cabeçalhos e rodapés repetitivos, foque no conteúdo processual.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `Texto do documento para análise:\n\n${text}`,
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: 32768 },
      responseMimeType: "application/json",
      responseSchema: SHARED_SCHEMA,
    },
  });

  const resultStr = response.text?.trim() || '{"processes":[]}';
  try {
    return JSON.parse(resultStr) as ExtractionResult;
  } catch (error) {
    console.error("Failed to parse Gemini response as JSON:", error);
    return { processes: [] };
  }
};

export const extractLegalDataFromModality = async (base64Data: string, mimeType: string, searchList?: string): Promise<ExtractionResult> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const prompt = searchList
    ? `Analise visualmente este documento (${mimeType}) e busque EXCLUSIVAMENTE estes processos: ${searchList}. 
       Para cada um, identifique o Foro correspondente. Retorne em JSON conforme o esquema.`
    : `Analise visualmente este documento (${mimeType}) e extraia todos os números de processo e seus respectivos foros (comarcas). 
       Retorne em JSON conforme o esquema.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType,
          },
        },
        { text: prompt },
      ],
    },
    config: {
      systemInstruction: "Você é um especialista em OCR e visão computacional jurídica. Extraia processos e foros de documentos (imagens ou PDFs digitalizados) com precisão absoluta.",
      responseMimeType: "application/json",
      responseSchema: SHARED_SCHEMA,
    },
  });

  const resultStr = response.text?.trim() || '{"processes":[]}';
  try {
    return JSON.parse(resultStr) as ExtractionResult;
  } catch (error) {
    console.error("Failed to parse Gemini multimodal response as JSON:", error);
    return { processes: [] };
  }
};
