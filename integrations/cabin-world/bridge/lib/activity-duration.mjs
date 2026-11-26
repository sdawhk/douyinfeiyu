export const CONTINUOUS_USES=new Set(['sink_in','read_comic','swim','soak','rest','sit','sit_bench','watch_clouds','shade','lie_grass','listen_waves','watch_sea','watch_fish','listen_music','browse_book','read_files','look_out','watch_video']);
export function activityDuration(spec,use,durationSeconds){
  if(durationSeconds===undefined)return spec;
  if(!CONTINUOUS_USES.has(use))throw Error('这项操作不支持自定时长；休息、游泳、泡汤等持续活动可指定 durationSeconds');
  if(!Number.isInteger(durationSeconds)||durationSeconds<0||durationSeconds>3600)throw Error('durationSeconds 须为0–3600秒；0为持续保持，直到自行结束');
  if(durationSeconds===0)return {...spec,seconds:3600,chosenDuration:true,hold:true};
  return {...spec,seconds:durationSeconds,chosenDuration:true};
}
