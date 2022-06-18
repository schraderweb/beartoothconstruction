const { createApp } = Vue;

createApp({
  data() {
    return {
      collections: null,
      path: "https://whispering-atoll-99593.herokuapp.com",
    };
  },
  async mounted() {
    await axios
      .get(
        "https://whispering-atoll-99593.herokuapp.com/api/posts?populate=images"
      )
      .then((res) => {
        const { data } = res.data;
        this.collections = data;
      });
  },
}).mount("#app");
