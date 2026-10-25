import React, {useEffect, useRef, useState} from 'react';

export default function LoginArchitecture() {
  const host = useRef(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false, dispose = () => {};
    import('three').then(THREE => {
      if (cancelled) return;
      const element = host.current;
      let renderer;
      try { renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, powerPreference:'low-power'}); }
      catch { setUnavailable(true); return; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      element.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-10,10,10,-10,.1,100);
      camera.position.set(17,15,20); camera.lookAt(0,2,0);
      scene.add(new THREE.HemisphereLight(0xffffff,0x729187,3));
      const sun = new THREE.DirectionalLight(0xfff7ed,4);
      sun.position.set(-8,20,9); sun.castShadow=true;
      sun.shadow.mapSize.set(1024,1024);
      Object.assign(sun.shadow.camera,{left:-15,right:15,top:15,bottom:-15,near:1,far:55});
      sun.shadow.bias=-.001; sun.shadow.normalBias=.04;
      scene.add(sun);
      const model = new THREE.Group(); scene.add(model);
      const materials = {}, geometries = new Set();
      const material = color => materials[color] ||= new THREE.MeshStandardMaterial({color,roughness:.85,metalness:.03});
      const box = (parent,w,h,d,x,y,z,color) => {
        const geometry = new THREE.BoxGeometry(w,h,d); geometries.add(geometry);
        const mesh = new THREE.Mesh(geometry,material(color));
        mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;parent.add(mesh);return mesh;
      };
      const beam = (parent,from,to,width,color) => {
        const a=new THREE.Vector3(...from), b=new THREE.Vector3(...to), direction=b.clone().sub(a);
        const mesh=box(parent,width,direction.length(),width,0,0,0,color);
        mesh.position.copy(a.add(b).multiplyScalar(.5));mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());return mesh;
      };
      const white=0xf8faf7, concrete=0xcbd7d1, dark=0x204d43, red=0xbf1942, glass=0x8caca5, orange=0xed9b49;
      box(model,15,.35,11,0,-.3,0,0xe1e8e3);
      box(model,14.7,.12,10.7,0,-.08,0,white);
      // Roads and paving belong to the miniature site, not a surrounding frame.
      box(model,15,.035,1.7,0,.01,4.3,0x586960);
      for(let x=-6.5;x<7;x+=1.4)box(model,.65,.01,.045,x,.035,4.3,white);
      box(model,1.5,.035,8,-6.3,.01,-.5,0x586960);
      for(let z=-4;z<3;z+=1.4)box(model,.045,.01,.6,-6.3,.035,z,white);
      const grid=new THREE.GridHelper(14,28,0xc6d2cb,0xe0e7e1);grid.position.y=.035;model.add(grid);
      const tower = (x,z,w,d,floors) => {
        for(let floor=0;floor<floors;floor++){
          const y=floor*.78;
          box(model,w+.2,.12,d+.2,x,y+.12,z,white);
          box(model,w-.15,.65,d-.15,x,y+.5,z,glass);
          for(const side of [-1,1]){
            for(let column=0;column<=3;column++)box(model,.11,.75,.13,x-w/2+column*w/3,y+.48,z+side*d/2,dark);
            for(let column=0;column<=2;column++)box(model,.13,.75,.11,x+side*w/2,y+.48,z-d/2+column*d/2,dark);
          }
        }
        box(model,w+.25,.16,d+.25,x,floors*.78+.1,z,white);
        box(model,w*.5,.3,d*.35,x,floors*.78+.3,z,concrete);
      };
      tower(-2.2,-1,3.1,2.8,7);
      tower(2.1,-2.5,2.5,2.5,4);
      // Exposed slabs and columns on the active building.
      for(let floor=0;floor<4;floor++){
        box(model,3.7,.15,2.6,2.1,.2+floor*.85,1.2,white);
        for(const x of [.5,2.1,3.7])for(const z of [.1,2.3])box(model,.17,.85,.17,x,.6+floor*.85,z,concrete);
      }
      for(let x=.6;x<4;x+=.5)box(model,.035,.6,.035,x,3.3,.15,red);
      box(model,3.9,.14,.06,2.1,2.15,2.52,red);
      const crane = new THREE.Group();crane.position.set(4.8,0,-.4);model.add(crane);
      const mastWidth=.52, height=8.1;
      for(const x of [-mastWidth/2,mastWidth/2])for(const z of [-mastWidth/2,mastWidth/2])box(crane,.075,height,.075,x,height/2,z,orange);
      for(let y=.3;y<height;y+=.7)for(const side of [-1,1]){
        beam(crane,[-.26,y,side*.26],[.26,y+.7,side*.26],.035,orange);
        beam(crane,[side*.26,y,-.26],[side*.26,y+.7,.26],.035,orange);
      }
      const jib = new THREE.Group();jib.position.y=height;crane.add(jib);
      box(jib,7.8,.12,.55,-2,0,0,orange);
      for(let x=-5.7;x<1.7;x+=.6){
        beam(jib,[x,0,-.25],[x+.6,.5,0],.035,orange);
        beam(jib,[x+.6,.5,0],[x+.6,0,.25],.035,orange);
      }
      beam(jib,[-5.9,0,0],[0,1.45,0],.025,dark);
      beam(jib,[1.8,0,0],[0,1.45,0],.025,dark);
      box(jib,1,.6,.8,1.4,-.4,0,concrete);
      box(jib,.75,.65,.8,-.3,-.5,.35,white);
      box(jib,.5,.38,.015,-.3,-.47,.76,glass);
      const lift=new THREE.Group();lift.position.x=-4.1;jib.add(lift);
      const cable=box(lift,.025,3.3,.025,0,-1.65,0,dark);
      const load=box(lift,1.1,.32,.9,0,-3.4,0,red);
      for(const x of [-.4,.4])beam(lift,[0,-2.9,0],[x,-3.25,0],.02,dark);
      for(let i=0;i<5;i++)box(model,1.4,.13,.35,-3.3,.15+i*.14,2.7,concrete);
      for(let i=0;i<4;i++)box(model,.3,.45,.3,-.8+i*.6,.22,3,orange);
      // Clipped, planted trees use simple manufactured-model shapes.
      for(const [x,z] of [[-4.7,-3.6],[-4.7,1.5],[5.8,2.8],[5.8,-3.5]]){
        box(model,.09,.55,.09,x,.28,z,dark);
        box(model,.65,.85,.65,x,1,z,0x4c7965);
        box(model,.45,.35,.45,x,1.55,z,0x719a7d);
      }
      const truck=new THREE.Group();model.add(truck);
      box(truck,1.2,.45,.65,0,.4,0,red);box(truck,.45,.6,.65,.7,.48,0,white);
      box(truck,.02,.22,.5,.94,.6,0,glass);
      for(const x of [-.4,.65])for(const z of [-.35,.35])box(truck,.24,.24,.12,x,.14,z,dark);
      const pointer={x:0,y:0},reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
      const resize=()=>{
        const {width,height}=element.getBoundingClientRect();if(!width||!height)return;
        renderer.setSize(width,height);
        const aspect=width/height,half=Math.max(8.6,10.2/aspect);
        camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.updateProjectionMatrix();renderer.render(scene,camera);
      };
      const observer=new ResizeObserver(resize);observer.observe(element);resize();
      const move=event=>{const rect=element.getBoundingClientRect();pointer.x=(event.clientX-rect.left)/rect.width-.5;pointer.y=(event.clientY-rect.top)/rect.height-.5;};
      const reset=()=>{pointer.x=0;pointer.y=0;};element.addEventListener('pointermove',move);element.addEventListener('pointerleave',reset);
      let last=0;
      const render=time=>{
        if(document.hidden||time-last<33)return;last=time;
        const t=reduced.matches?0:time*.001;
        model.rotation.y += ((reduced.matches?0:pointer.x*.12)-model.rotation.y)*.05;
        jib.rotation.y=.12+Math.sin(t*.22)*.26;
        lift.position.x=-3.7+Math.sin(t*.4)*.55;
        const length=3.2+Math.sin(t*.65)*.35;cable.scale.y=length/3.3;cable.position.y=-length/2;load.position.y=-length-.1;
        truck.position.set(((t*.55+3)%11)-5.5,0,4.3);
        renderer.render(scene,camera);
      };
      render(100);
      const updateMotion=()=>{renderer.setAnimationLoop(reduced.matches?null:render);if(reduced.matches)render(last+40);};
      updateMotion();reduced.addEventListener('change',updateMotion);
      const lost=event=>{event.preventDefault();renderer.setAnimationLoop(null);setUnavailable(true);};renderer.domElement.addEventListener('webglcontextlost',lost);
      dispose=()=>{
        renderer.setAnimationLoop(null);observer.disconnect();element.removeEventListener('pointermove',move);element.removeEventListener('pointerleave',reset);reduced.removeEventListener('change',updateMotion);
        renderer.domElement.removeEventListener('webglcontextlost',lost);scene.traverse(object=>{if(object.geometry)geometries.add(object.geometry);});
        geometries.forEach(geometry=>geometry.dispose());Object.values(materials).forEach(value=>value.dispose());grid.material.dispose();renderer.dispose();renderer.domElement.remove();
      };
    }).catch(()=>{if(!cancelled)setUnavailable(true);});
    return()=>{cancelled=true;dispose();};
  },[]);
  return <div ref={host} className={`login-architecture${unavailable?' is-unavailable':''}`} aria-hidden="true">
    <div className="login-architecture-fallback"><i/><i/><i/><i/></div>
  </div>;
}
