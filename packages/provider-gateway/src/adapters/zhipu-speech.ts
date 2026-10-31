import {ProviderGatewayError} from "../errors.js";
import type {ProviderAdapter} from "../types.js";
import type {ProviderHttpTransport} from "./http-transport.js";
import {approvedProfile,authHeaders} from "./provider-profiles.js";
import {failureForStatus,header} from "./shared.js";

/** Official GLM-TTS binary WAV contract, deliberately independent of OpenAI
 * Speech controls. Never sends unsupported pitch, instructions, SSML or clones. */
export class ZhipuSpeechAdapter implements ProviderAdapter {
 constructor(private readonly transport:ProviderHttpTransport){}
 async execute(input:Parameters<ProviderAdapter["execute"]>[0]){
  const speech=input.request.speech,profile=approvedProfile(input.snapshot.providerKey,"SPEECH",input.snapshot.endpoint,input.snapshot.configuration);
  if(input.snapshot.providerKey!=="zhipu"||!profile||profile.protocol!=="CUSTOM_SPEECH"||input.snapshot.modelId!=="glm-tts")throw new ProviderGatewayError("NETWORK_POLICY_REJECTED");
  if(!speech||!speech.text.trim()||speech.text.length>1024||speech.outputFormat!=="wav"||speech.ssml||speech.voice.pitch!==0||speech.voice.style||!Number.isFinite(speech.voice.speakingRate)||speech.voice.speakingRate<0.5||speech.voice.speakingRate>2||!["tongtong","xiaochen","chuichui","jam","kazi","douji","luodo"].includes(speech.voice.providerVoiceId))throw new ProviderGatewayError("CAPABILITY_MISMATCH");
  const remote=await this.transport.executeBinary({url:profile.endpoint,method:"POST",headers:{"content-type":"application/json",...authHeaders(profile.authScheme,input.credential)},body:JSON.stringify({model:"glm-tts",input:speech.text,voice:speech.voice.providerVoiceId,response_format:"wav",stream:false,speed:speech.voice.speakingRate,volume:1,watermark_enabled:true}),signal:input.signal});
  failureForStatus({status:remote.status,headers:remote.headers,body:""});
  const bytes=Buffer.from(remote.bytes);
  const invalid=()=>new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
  if(bytes.length<44||bytes.toString("ascii",0,4)!=="RIFF"||bytes.toString("ascii",8,12)!=="WAVE")throw invalid();
  const declaredLength=bytes.readUInt32LE(4)+8;
  let sampleRate=0,channels=0,dataBytes=0,seenFormat=false,seenData=false,watermarked=false;
  for(let offset=12;offset<bytes.length;){
   if(offset+8>bytes.length)throw invalid();const tag=bytes.toString("ascii",offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;if(end>bytes.length)throw invalid();
   if(tag==="fmt "){
    if(seenFormat||size<16||bytes.readUInt16LE(start)!==1||bytes.readUInt16LE(start+14)!==16)throw invalid();
    channels=bytes.readUInt16LE(start+2);sampleRate=bytes.readUInt32LE(start+4);
    if(![1,2].includes(channels)||sampleRate<8000||sampleRate>96000||bytes.readUInt16LE(start+12)!==channels*2||bytes.readUInt32LE(start+8)!==sampleRate*channels*2)throw invalid();seenFormat=true;
   }
   if(tag==="data"){if(seenData||!size)throw invalid();seenData=true;dataBytes=size;}
   if(tag==="AIGC"&&size<=8192){try{watermarked=JSON.parse(bytes.toString("utf8",start,bytes[end-1]===0?end-1:end)).Label==="1";}catch{throw invalid();}}
   offset=end+(size%2);if(offset>bytes.length)throw invalid();
  }
  if(!seenFormat||!seenData||dataBytes%(channels*2))throw invalid();
  // Observed official watermarked WAV: every chunk is complete, but RIFF's
  // length is four bytes short. Correct only this demonstrated container
  // defect after validating every chunk. Keep AIGC metadata and PCM unchanged.
  const normalized=declaredLength!==bytes.length;
  if(normalized){if(!watermarked||declaredLength+4!==bytes.length)throw invalid();bytes.writeUInt32LE(bytes.length-8,4);}
  return {response:{bytes:new Uint8Array(bytes),mediaType:"audio/wav",format:"wav",sampleRate,channels,durationMs:dataBytes/(sampleRate*channels*2)*1000,providerModel:"glm-tts"},usage:{speechInputCharacters:speech.text.length,extra:{usageQuality:"LOCAL_DETERMINISTIC_ESTIMATE",providerReportedUsage:false,containerLengthCorrected:normalized}},remoteRequestId:header(remote.headers,"x-request-id")??header(remote.headers,"request-id")};
 }
}
