/**
 * Basit LLM test scripti
 * Kullanım: pnpm tsx scripts/test-llm.ts
 */
import { complete } from '../apps/runtime/src/llm/client.js';

async function main() {
  console.log('🧪 UAI LLM Test — Claude\'a merhaba diyorum...\n');

  const result = await complete({
    model: 'haiku',
    prompt: 'Merhaba! Sen UAI sisteminin parçasısın. Tek cümleyle kendini tanıt.',
    maxTokens: 100,
  });

  console.log('📝 Yanıt:', result.text);
  console.log('📊 Tokens:', result.tokensUsed);
  console.log('💰 Maliyet: $' + result.costUsd.toFixed(6));
  console.log('\n✅ LLM test başarılı!');
}

main().catch((err) => {
  console.error('❌ LLM test başarısız:', err.message);
  process.exit(1);
});
