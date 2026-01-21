
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Blob } from '@google/genai';
import { FREQUENCIES, FrequencyType, Message } from './types';
import { encode, decode, decodeAudioData } from './services/audioUtils';

const App: React.FC = () => {
  const [scrollProgress, setScrollProgress] = useState(0);
  const [frequency, setFrequency] = useState(FREQUENCIES[0]);
  const [isPttActive, setIsPttActive] = useState(false);
  const [isSquelching, setIsSquelching] = useState(false);
  const [volume, setVolume] = useState(70);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isModelTalking, setIsModelTalking] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);

  // Audio Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const outputGainNodeRef = useRef<GainNode | null>(null);
  const sessionRef = useRef<any>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  // Smooth Scroll Handler
  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const winScroll = window.scrollY;
          const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
          const scrolled = Math.min(1, Math.max(0, winScroll / height));
          setScrollProgress(scrolled);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const playStaticBurst = useCallback((duration = 0.15, volumeMult = 0.05) => {
    if (!outputAudioContextRef.current || !outputGainNodeRef.current) return;
    const ctx = outputAudioContextRef.current;
    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      const fade = 1 - (i / bufferSize);
      data[i] = (Math.random() * 2 - 1) * volumeMult * fade;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGainNodeRef.current);
    source.start();
    setIsSquelching(true);
    setTimeout(() => setIsSquelching(false), duration * 1000);
  }, []);

  const playRadioChirp = useCallback(() => {
    if (!outputAudioContextRef.current || !outputGainNodeRef.current) return;
    const ctx = outputAudioContextRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1760, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    osc.connect(gain);
    gain.connect(outputGainNodeRef.current);
    osc.start();
    osc.stop(ctx.currentTime + 0.05);
  }, []);

  const connectToChannel = useCallback(async () => {
    if (sessionRef.current) return;
    setIsConnecting(true);
    setConnectionStatus('PERM CHECK');
    
    // Check for Secure Context (Required for Microphone)
    if (!window.isSecureContext) {
      setConnectionStatus('ERR: INSECURE');
      setIsConnecting(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      setConnectionStatus('NET SYNC');
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const gainNode = outputAudioContextRef.current.createGain();
      gainNode.gain.value = volume / 100;
      gainNode.connect(outputAudioContextRef.current.destination);
      outputGainNodeRef.current = gainNode;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
          },
          systemInstruction: `You are a tactical squad member. 
          User is Alpha 1. You are Dispatch and Unit 7. 
          Be gritty and professional. Prefix names. Short transmissions only.`,
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            setConnectionStatus('LINK EST');
            playRadioChirp();
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            const transcription = message.serverContent?.outputTranscription?.text;
            if (transcription) {
               if (transcription.toLowerCase().includes('dispatch')) setActiveSpeaker('DISPATCH');
               else if (transcription.toLowerCase().includes('unit 7')) setActiveSpeaker('UNIT 7');
               else setActiveSpeaker('RX UNIT');
            }
            if (audioData && outputAudioContextRef.current) {
              setIsModelTalking(true);
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputGainNodeRef.current!);
              source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) {
                  setIsModelTalking(false);
                  setActiveSpeaker(null);
                  playStaticBurst(0.1, 0.02);
                }
              };
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }
          },
          onerror: () => { setConnectionStatus('ERR: LINK'); disconnect(); },
          onclose: () => disconnect()
        }
      });
      sessionRef.current = await sessionPromise;
      const source = inputAudioContextRef.current.createMediaStreamSource(stream);
      const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = scriptProcessor;
      scriptProcessor.onaudioprocess = (e) => {
        if (isPttActive && sessionRef.current) {
          const inputData = e.inputBuffer.getChannelData(0);
          sessionRef.current.sendRealtimeInput({ media: createBlob(inputData) });
        }
      };
      source.connect(scriptProcessor);
      scriptProcessor.connect(inputAudioContextRef.current.destination);
    } catch (err) {
      setConnectionStatus('ERR: MIC');
      setIsConnecting(false);
    }
  }, [frequency, isPttActive, volume, playRadioChirp, playStaticBurst]);

  const disconnect = () => {
    if (sessionRef.current) sessionRef.current.close();
    sessionRef.current = null;
    if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
    if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
    audioSourcesRef.current.forEach(s => s.stop());
    audioSourcesRef.current.clear();
    setIsConnected(false);
    setIsConnecting(false);
    setIsPttActive(false);
    setActiveSpeaker(null);
  };

  const createBlob = (data: Float32Array): Blob => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) int16[i] = data[i] * 32768;
    return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
  };

  useEffect(() => { if (isConnected) disconnect(); }, [frequency.value]);
  useEffect(() => { if (outputGainNodeRef.current) outputGainNodeRef.current.gain.value = volume / 100; }, [volume]);

  const handlePttDown = () => { if (isConnected) { playRadioChirp(); setIsPttActive(true); } };
  const handlePttUp = () => { if (isPttActive) playStaticBurst(); setIsPttActive(false); };

  const getFlyStyles = (rangeStart: number, rangeEnd: number) => {
    const range = rangeEnd - rangeStart;
    const localProgress = Math.max(0, Math.min(1, (scrollProgress - rangeStart) / range));
    const z = -2000 + (localProgress * 4000);
    const opacity = localProgress < 0.2 ? localProgress * 5 : localProgress > 0.8 ? (1 - localProgress) * 5 : 1;
    return {
      transform: `translateZ(${z}px)`,
      opacity: Math.max(0, Math.min(1, opacity)),
      visibility: localProgress > 0 && localProgress < 1 ? 'visible' : 'hidden' as any
    };
  };

  const introOpacity = Math.max(0, 1 - (scrollProgress * 4));
  const introScale = 1 - (scrollProgress * 0.15);
  const deviceScale = Math.max(0, Math.min(1, (scrollProgress - 0.7) / 0.3));
  const deviceOpacity = Math.max(0, Math.min(1, (scrollProgress - 0.8) / 0.2));
  const isFinalStage = scrollProgress > 0.98;

  return (
    <div className="relative w-full bg-[#050505]">
      <div className="h-[600vh] w-full pointer-events-none"></div>
      <div className="fixed inset-0 perspective-container flex items-center justify-center overflow-hidden pointer-events-none">
        <div 
          className="absolute inset-0 flex flex-col items-center justify-center p-8 transition-all duration-500 ease-out"
          style={{ opacity: introOpacity, transform: `scale(${introScale})` }}
        >
          <div className="w-full max-w-4xl border-l border-neutral-800 pl-8 relative">
             <div className="absolute top-0 left-0 w-6 h-px bg-blue-500"></div>
             <div className="absolute bottom-0 left-0 w-6 h-px bg-blue-500"></div>
             <h2 className="text-blue-500 text-[10px] font-bold tracking-[0.6em] mb-4 uppercase">Neural-Link Active</h2>
             <h1 className="glitch text-white text-6xl md:text-8xl font-black tracking-tighter italic uppercase mb-6" data-text="TACTICAL-PR">
               TACTICAL-PR
             </h1>
             <p className="text-neutral-400 text-lg md:text-2xl max-w-2xl tracking-tight leading-snug mb-10">
               Next-generation field coordination. Seamlessly transition between tactical frequencies via low-latency audio for mission-critical reliability.
             </p>
             <div className="flex flex-wrap gap-8 md:gap-16 text-[10px] text-neutral-600 font-bold uppercase tracking-widest">
                <div className="flex flex-col gap-1">
                   <span className="text-neutral-500">System Link</span>
                   <span className="text-blue-500">Stable</span>
                </div>
                <div className="flex flex-col gap-1">
                   <span className="text-neutral-500">Voice Sync</span>
                   <span className="text-green-500">Active</span>
                </div>
                <div className="flex flex-col gap-1">
                   <span className="text-neutral-500">Security Level</span>
                   <span className="text-red-900">Encrypted</span>
                </div>
             </div>
          </div>
        </div>

        <div className="absolute fly-text font-black text-8xl text-blue-600/20 text-center tracking-[2em] whitespace-nowrap italic uppercase" style={getFlyStyles(0.1, 0.5)}>Neural Link</div>
        <div className="absolute fly-text font-black text-6xl text-neutral-300/40 text-center tracking-[1em] whitespace-nowrap uppercase" style={getFlyStyles(0.4, 0.8)}>Secure Tactical Net</div>

        <div 
          className="absolute flex flex-col items-center justify-center transition-all duration-700 ease-out"
          style={{ 
            transform: `scale(${deviceScale}) translateY(${(1 - deviceOpacity) * 80}px)`,
            opacity: deviceOpacity,
            pointerEvents: isFinalStage ? 'auto' : 'none'
          }}
        >
          <div className="mb-6 text-center transform scale-75 opacity-60">
            <h1 className="text-2xl font-bold text-neutral-400 tracking-tighter uppercase italic">
              Field Pro <span className="text-white">G-2025</span>
            </h1>
            <p className="text-[10px] text-neutral-600 font-bold tracking-widest uppercase">3-Unit Squad Net</p>
          </div>

          <div className="relative w-80 bg-neutral-900 border-x-8 border-t-8 border-neutral-800 rounded-t-[3rem] rounded-b-2xl shadow-2xl p-6 pb-12 transition-all duration-500 hover:shadow-blue-500/5">
            <div className="absolute -top-32 left-10 w-4 h-32 bg-neutral-800 rounded-t-full flex items-center justify-center">
              <div className="w-1 h-full bg-neutral-700"></div>
              <div className="absolute top-0 w-6 h-2 bg-neutral-900 rounded-full"></div>
            </div>

            <div className="flex justify-between -mt-10 mb-4 px-4">
              <div className="flex flex-col items-center">
                <span className="text-[10px] text-neutral-500 mb-1 font-bold">VOL</span>
                <div 
                  className="w-10 h-10 bg-neutral-800 rounded-full border-2 border-neutral-700 flex items-center justify-center transition-transform cursor-pointer hover:bg-neutral-750 active:scale-90"
                  style={{ transform: `rotate(${(volume / 100) * 270 - 135}deg)` }}
                  onClick={() => setVolume(v => (v + 20) % 120)}
                >
                  <div className="w-1 h-3 bg-red-500 -mt-4 rounded-full"></div>
                </div>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-[10px] text-neutral-500 mb-1 font-bold">CHAN</span>
                <div 
                  className="w-10 h-10 bg-neutral-800 rounded-full border-2 border-neutral-700 flex items-center justify-center transition-transform cursor-pointer hover:bg-neutral-750 active:scale-90"
                  onClick={() => {
                    const nextIdx = (FREQUENCIES.findIndex(f => f.value === frequency.value) + 1) % FREQUENCIES.length;
                    setFrequency(FREQUENCIES[nextIdx]);
                  }}
                >
                  <div className="w-1 h-3 bg-neutral-400 -mt-4 rounded-full"></div>
                </div>
              </div>
            </div>

            <div className="lcd-screen rounded-md p-3 mb-6 font-mono border-2 border-neutral-700 shadow-inner h-44 flex flex-col justify-between overflow-hidden">
              <div className="flex justify-between items-start">
                <div className="flex flex-col">
                  <span className="text-[9px] font-bold opacity-60 uppercase tracking-tighter">Frequency MHZ</span>
                  <span className="text-xl font-bold tracking-widest">{frequency.value}</span>
                </div>
                <div className="flex items-center gap-1">
                  <i className={`fas fa-signal text-xs ${isConnected ? 'opacity-100 text-green-900 animate-pulse' : 'opacity-20'}`}></i>
                  <span className="text-[10px] font-bold">{frequency.name}</span>
                </div>
              </div>
              
              <div className="flex-1 my-1 overflow-hidden border-y border-neutral-900/20 py-1">
                {isConnecting ? (
                  <div className="flex items-center justify-center h-full animate-pulse">
                    <span className="text-[xs] font-bold tracking-widest">{connectionStatus}</span>
                  </div>
                ) : isConnected ? (
                  <div className="h-full flex flex-col">
                    <div className="flex justify-between text-[8px] font-bold mb-1 opacity-80 border-b border-neutral-900/10 pb-0.5">
                      <span className="text-neutral-900">SQUAD:</span>
                      <span className="text-blue-900">[ALPHA 1]</span>
                      <span className={activeSpeaker === 'DISPATCH' ? 'bg-red-800 text-white px-0.5 animate-pulse' : 'opacity-40'}>[DISPATCH]</span>
                      <span className={activeSpeaker === 'UNIT 7' ? 'bg-red-800 text-white px-0.5 animate-pulse' : 'opacity-40'}>[UNIT 7]</span>
                    </div>
                    <div className="flex-1 text-[10px] flex flex-col justify-end leading-tight">
                       <div className="flex items-center justify-center opacity-40 italic h-full">
                          {isPttActive ? (
                            <span className="text-red-900 animate-pulse font-bold">TRANSMITTING...</span>
                          ) : isModelTalking ? (
                            <span className="text-green-900 font-bold uppercase tracking-widest">{activeSpeaker || 'INCOMING'}</span>
                          ) : (
                            <div className="flex flex-col items-center">
                               <span className="text-[8px]">NET SECURE</span>
                            </div>
                          )}
                       </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full opacity-30">
                    <span className="text-xs font-bold uppercase tracking-widest">{connectionStatus || 'OFFLINE'}</span>
                    <span className="text-[8px] animate-pulse">Connect to Tactical Net</span>
                  </div>
                )}
              </div>

              <div className="flex justify-between items-center text-[10px]">
                <div className="flex items-center gap-1">
                  <div className={`w-2 h-2 rounded-full ${isPttActive ? 'bg-red-600 animate-pulse' : isModelTalking ? 'bg-green-600' : isSquelching ? 'bg-neutral-600 animate-ping' : 'bg-neutral-800 opacity-20'}`}></div>
                  <span className="font-bold uppercase tracking-tight">
                    {isPttActive ? 'TX' : isModelTalking ? 'RX' : isSquelching ? 'SQ' : 'STBY'}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="font-bold">VOL:</span>
                  <span>{Math.round(volume)}%</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-6 gap-2 px-6 mb-8 opacity-40">
              {Array.from({ length: 18 }).map((_, i) => (
                <div key={i} className="w-full h-1 bg-neutral-600 rounded-full"></div>
              ))}
            </div>

            <div className="flex flex-col gap-4">
              <button
                onMouseDown={handlePttDown}
                onMouseUp={handlePttUp}
                onTouchStart={handlePttDown}
                onTouchEnd={handlePttUp}
                disabled={!isConnected}
                className={`
                  w-full h-24 rounded-2xl flex flex-col items-center justify-center transition-all duration-75 active:scale-95
                  ${isConnected 
                    ? 'bg-neutral-800 border-b-8 border-neutral-950 active:border-b-0 hover:bg-neutral-750 cursor-pointer' 
                    : 'bg-neutral-800 opacity-40 cursor-not-allowed'}
                  ${isPttActive ? 'bg-red-900 border-red-950 ptt-active text-white' : 'text-neutral-400'}
                `}
              >
                <i className={`fas fa-microphone-alt text-2xl mb-1 ${isPttActive ? 'animate-pulse' : ''}`}></i>
                <span className="text-xs font-bold tracking-widest uppercase">Push To Talk</span>
              </button>
              {!isConnected ? (
                <button
                  onClick={connectToChannel}
                  disabled={isConnecting}
                  className="w-full py-4 rounded-lg bg-blue-700 text-blue-100 font-bold uppercase tracking-widest text-sm hover:bg-blue-600 active:scale-95 transition-all shadow-lg"
                >
                  {isConnecting ? 'Linking...' : 'Establish Net Link'}
                </button>
              ) : (
                <button onClick={disconnect} className="w-full py-4 rounded-lg bg-neutral-800 text-neutral-500 font-bold uppercase tracking-widest text-sm hover:bg-neutral-700 active:scale-95 transition-all">Terminate Link</button>
              )}
            </div>
          </div>
          <div className="mt-8 text-neutral-700 text-[10px] tracking-[0.4em] uppercase opacity-40 font-bold flex flex-col items-center gap-2">
            <i className="fas fa-chevron-up animate-bounce"></i>
            Scroll up to disconnect
          </div>
        </div>
      </div>

      {isPttActive && isFinalStage && (
        <div className="fixed top-10 left-1/2 -translate-x-1/2 bg-red-600/30 border border-red-600/50 text-red-500 px-8 py-3 rounded-full backdrop-blur-md font-black text-xs animate-pulse flex items-center gap-3 z-50 tracking-widest uppercase">
          <i className="fas fa-broadcast-tower"></i>
          Signal Transmitting
        </div>
      )}
      {scrollProgress < 0.05 && (
        <div className="fixed bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center text-blue-500/60 animate-bounce transition-opacity duration-500 pointer-events-none">
          <span className="text-[10px] font-bold uppercase tracking-[0.4em] mb-2">Deploy Field Unit</span>
          <i className="fas fa-chevron-down"></i>
        </div>
      )}
    </div>
  );
};

export default App;
